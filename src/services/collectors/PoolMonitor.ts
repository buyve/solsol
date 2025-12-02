import { EventEmitter } from 'events';
import { GrpcClient, PROGRAM_IDS, CommitmentLevel } from '../external/GrpcClient.js';
import type { SubscribeUpdate, SubscribeRequest } from '../external/GrpcClient.js';
import { ShyftClient, PoolInfo } from '../external/ShyftClient.js';
import { logger } from '../../utils/logger.js';
import { cache } from '../../config/redis.js';
import { bytesToBase58 } from '../../utils/solana.js';
import { PoolRepository } from '../repositories/PoolRepository.js';
import { TokenRepository } from '../repositories/TokenRepository.js';

export interface PoolUpdate {
  poolAddress: string;
  tokenMint: string;
  quoteMint: string;
  dex: string;
  baseReserve: bigint;
  quoteReserve: bigint;
  previousBaseReserve?: bigint;
  previousQuoteReserve?: bigint;
  priceChange?: number;
  liquidityChange?: number;
  slot: number;
  timestamp: Date;
}

export interface PoolMonitorOptions {
  pollIntervalMs?: number;
  cachePoolInfo?: boolean;
  cacheTTL?: number;
  enablePollingFallback?: boolean; // Enable polling even without Shyft key
}

export type MonitoringMode = 'grpc' | 'polling' | 'hybrid' | 'disabled';

export interface MonitoringStatus {
  mode: MonitoringMode;
  isHealthy: boolean;
  lastUpdateTime: Date | null;
  errorCount: number;
  poolCount: number;
  details: {
    grpcConnected: boolean;
    shyftConfigured: boolean;
    pollingActive: boolean;
  };
}

export class PoolMonitor extends EventEmitter {
  private grpcClient: GrpcClient;
  private shyftClient: ShyftClient;
  private poolRepository: PoolRepository;
  private tokenRepository: TokenRepository;
  private isRunning: boolean = false;
  private monitoredPools: Map<string, PoolInfo> = new Map();
  private pendingPools: Map<string, PoolInfo> = new Map(); // Pools to add to subscription
  private updateCount: number = 0;
  private pollIntervalMs: number;
  private pollIntervalId?: NodeJS.Timeout;
  private cachePoolInfo: boolean;
  private cacheTTL: number;
  private enablePollingFallback: boolean;
  private monitoringMode: MonitoringMode = 'disabled';
  private lastUpdateTime: Date | null = null;
  private errorCount: number = 0;
  private resubscribeDebounceId?: NodeJS.Timeout;
  private grpcConnected: boolean = false;

  constructor(options?: PoolMonitorOptions) {
    super();
    this.grpcClient = new GrpcClient();
    this.shyftClient = new ShyftClient();
    this.poolRepository = new PoolRepository();
    this.tokenRepository = new TokenRepository();
    this.pollIntervalMs = options?.pollIntervalMs ?? 5000; // 5 seconds default
    this.cachePoolInfo = options?.cachePoolInfo ?? true;
    this.cacheTTL = options?.cacheTTL ?? 300; // 5 minutes
    this.enablePollingFallback = options?.enablePollingFallback ?? true;
  }

  /**
   * Start monitoring pools
   * Uses gRPC for real-time account updates when possible,
   * falls back to polling via REST API
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('PoolMonitor is already running');
      return;
    }

    this.isRunning = true;
    this.errorCount = 0;
    logger.info('Starting PoolMonitor...');

    const grpcConfigured = this.grpcClient.isConfigured();
    const shyftConfigured = this.shyftClient.isConfigured();

    // Determine monitoring mode
    if (grpcConfigured && shyftConfigured) {
      this.monitoringMode = 'hybrid';
      await this.startGrpcMonitoring();
      // Also start polling as backup for new pools
      this.startPolling();
    } else if (grpcConfigured) {
      this.monitoringMode = 'grpc';
      await this.startGrpcMonitoring();
    } else if (shyftConfigured) {
      this.monitoringMode = 'polling';
      this.startPolling();
    } else if (this.enablePollingFallback) {
      // Minimal polling mode - try to work without API keys
      this.monitoringMode = 'polling';
      logger.warn('No API keys configured - running in limited polling mode');
      this.startPolling();
    } else {
      this.monitoringMode = 'disabled';
      logger.error('No monitoring method available - PoolMonitor disabled');
    }

    logger.info('PoolMonitor started', {
      mode: this.monitoringMode,
      grpcConfigured,
      shyftConfigured,
      monitoredPools: this.monitoredPools.size,
    });

    this.emit('started');
  }

  /**
   * Stop monitoring
   */
  async stop(): Promise<void> {
    this.isRunning = false;
    this.monitoringMode = 'disabled';

    if (this.pollIntervalId) {
      clearInterval(this.pollIntervalId);
      this.pollIntervalId = undefined;
    }

    if (this.resubscribeDebounceId) {
      clearTimeout(this.resubscribeDebounceId);
      this.resubscribeDebounceId = undefined;
    }

    this.grpcConnected = false;
    await this.grpcClient.disconnect();
    logger.info('PoolMonitor stopped', {
      totalUpdates: this.updateCount,
      monitoredPools: this.monitoredPools.size,
    });
    this.emit('stopped');
  }

  /**
   * Add a pool to monitor
   */
  async addPool(poolAddress: string, tokenMint?: string): Promise<boolean> {
    try {
      // Skip if already monitoring
      if (this.monitoredPools.has(poolAddress)) {
        return true;
      }

      // Fetch pool info if not provided
      let poolInfo: PoolInfo | null = null;

      if (this.shyftClient.isConfigured()) {
        poolInfo = await this.shyftClient.getPoolInfo(poolAddress);
      }

      if (!poolInfo && tokenMint) {
        // Create a minimal pool info
        poolInfo = {
          poolAddress,
          dex: 'unknown',
          baseMint: tokenMint,
          quoteMint: 'So11111111111111111111111111111111111111112', // SOL
          baseReserve: '0',
          quoteReserve: '0',
        };
      }

      if (!poolInfo) {
        logger.warn('Could not get pool info', { poolAddress });
        return false;
      }

      this.monitoredPools.set(poolAddress, poolInfo);

      // Track as pending for gRPC resubscription
      this.pendingPools.set(poolAddress, poolInfo);

      // Add to Redis set for persistence
      await this.addToActivePoolsSet(poolAddress);

      // Trigger gRPC resubscription if running in gRPC/hybrid mode
      if (this.isRunning && (this.monitoringMode === 'grpc' || this.monitoringMode === 'hybrid')) {
        this.scheduleResubscription();
      }

      logger.info('Pool added to monitoring', {
        poolAddress,
        dex: poolInfo.dex,
        baseMint: poolInfo.baseMint,
        mode: this.monitoringMode,
      });

      return true;
    } catch (error) {
      logger.error('Failed to add pool', { poolAddress, error });
      return false;
    }
  }

  /**
   * Schedule gRPC resubscription (debounced)
   * Batches multiple pool additions to avoid excessive reconnections
   */
  private scheduleResubscription(): void {
    if (this.resubscribeDebounceId) {
      clearTimeout(this.resubscribeDebounceId);
    }

    // Wait 2 seconds to batch multiple pool additions
    this.resubscribeDebounceId = setTimeout(async () => {
      if (this.pendingPools.size > 0 && this.isRunning) {
        logger.info('Resubscribing gRPC with new pools', {
          newPoolCount: this.pendingPools.size,
          totalPools: this.monitoredPools.size,
        });

        // Clear pending pools
        this.pendingPools.clear();

        // Reconnect with updated subscription
        try {
          await this.grpcClient.disconnect();
          await this.startGrpcMonitoring();
        } catch (error) {
          logger.error('Failed to resubscribe gRPC', { error });
          this.errorCount++;
        }
      }
    }, 2000);
  }

  /**
   * Remove a pool from monitoring
   */
  async removePool(poolAddress: string): Promise<void> {
    this.monitoredPools.delete(poolAddress);
    await this.removeFromActivePoolsSet(poolAddress);
    logger.info('Pool removed from monitoring', { poolAddress });
  }

  /**
   * Add pools by token mint
   */
  async addPoolsByToken(tokenMint: string): Promise<number> {
    if (!this.shyftClient.isConfigured()) {
      logger.warn('Shyft client not configured, cannot fetch pools');
      return 0;
    }

    try {
      const pools = await this.shyftClient.getPoolsByToken(tokenMint);
      let addedCount = 0;

      for (const pool of pools) {
        if (await this.addPool(pool.poolAddress, tokenMint)) {
          addedCount++;
        }
      }

      logger.info('Added pools for token', { tokenMint, count: addedCount });
      return addedCount;
    } catch (error) {
      logger.error('Failed to add pools by token', { tokenMint, error });
      return 0;
    }
  }

  /**
   * Start gRPC-based real-time monitoring (non-blocking)
   */
  private async startGrpcMonitoring(): Promise<void> {
    try {
      await this.grpcClient.connect();
      this.grpcConnected = true;

      // Subscribe to account changes for monitored pools (background)
      const request = this.buildAccountSubscription();

      // Run subscription in background
      this.runGrpcSubscriptionLoop(request);

      logger.info('PoolMonitor gRPC subscription started in background', {
        monitoredPools: this.monitoredPools.size,
      });
    } catch (error) {
      this.grpcConnected = false;
      this.errorCount++;
      logger.error('gRPC monitoring failed, falling back to polling', { error });

      // Only start polling if not already running
      if (!this.pollIntervalId) {
        this.monitoringMode = 'polling';
        this.startPolling();
      }
    }
  }

  /**
   * Run gRPC subscription loop in background
   */
  private runGrpcSubscriptionLoop(request: SubscribeRequest): void {
    this.grpcClient.subscribe(request, async (update) => {
      await this.handleAccountUpdate(update);
      this.lastUpdateTime = new Date();
    }).catch((error) => {
      this.grpcConnected = false;
      this.errorCount++;

      if (!this.isRunning) return; // Expected during shutdown

      logger.error('PoolMonitor gRPC subscription error, falling back to polling', { error });

      // Only start polling if not already running
      if (!this.pollIntervalId) {
        this.monitoringMode = 'polling';
        this.startPolling();
      }
    });
  }

  /**
   * Build account subscription request for monitored pools
   * This subscribes directly to account data changes, not transactions
   */
  private buildAccountSubscription(): SubscribeRequest {
    const accounts: SubscribeRequest['accounts'] = {};

    // Subscribe to each monitored pool account directly
    // This gives us real-time updates when pool reserves change
    let index = 0;
    for (const poolAddress of this.monitoredPools.keys()) {
      accounts[`pool_${index}`] = {
        account: [poolAddress],
        owner: [],
        filters: [],
      };
      index++;
    }

    // If no pools are monitored yet, subscribe to DEX program accounts
    // to catch new pools
    if (index === 0) {
      // Subscribe by program owner to catch all pools for major DEXes
      accounts['raydium_pools'] = {
        account: [],
        owner: [PROGRAM_IDS.RAYDIUM_AMM_V4],
        filters: [],
      };
      accounts['pumpswap_pools'] = {
        account: [],
        owner: [PROGRAM_IDS.PUMP_SWAP_AMM],
        filters: [],
      };
    }

    return {
      accounts,
      slots: {},
      transactions: {},
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      commitment: CommitmentLevel.PROCESSED,
      accountsDataSlice: [],
      ping: undefined,
    };
  }

  /**
   * Handle account update from gRPC
   */
  private async handleAccountUpdate(update: SubscribeUpdate): Promise<void> {
    // Handle direct account updates (preferred method)
    if (update.account) {
      const account = update.account;
      const pubkey = account.account?.pubkey;

      if (pubkey) {
        const poolAddress = bytesToBase58(pubkey);

        // Check if this is a monitored pool
        if (this.monitoredPools.has(poolAddress)) {
          await this.refreshPoolAndEmit(poolAddress, Number(account.slot || 0));
        }
      }
      return;
    }

    // Fallback: handle transaction updates for pools involved in swaps
    if (update.transaction) {
      const tx = update.transaction;
      const message = tx.transaction?.transaction?.message;
      if (!message?.accountKeys) return;

      const accountKeys = message.accountKeys.map((key: Uint8Array) =>
        bytesToBase58(key)
      );

      // Check if any monitored pools are involved
      for (const poolAddress of this.monitoredPools.keys()) {
        if (accountKeys.includes(poolAddress)) {
          await this.refreshPoolAndEmit(poolAddress, Number(tx.slot));
        }
      }
    }
  }

  /**
   * Start polling-based monitoring
   */
  private startPolling(): void {
    logger.info('Starting poll-based pool monitoring', {
      intervalMs: this.pollIntervalMs,
    });

    this.pollIntervalId = setInterval(async () => {
      await this.pollAllPools();
    }, this.pollIntervalMs);

    // Initial poll
    this.pollAllPools();
  }

  /**
   * Poll all monitored pools for updates
   */
  private async pollAllPools(): Promise<void> {
    if (this.monitoredPools.size === 0) {
      logger.debug('No pools to poll');
      return;
    }

    if (!this.shyftClient.isConfigured()) {
      // Log only periodically to avoid spam
      if (this.updateCount % 12 === 0) {
        logger.debug('Polling skipped - Shyft client not configured', {
          monitoredPools: this.monitoredPools.size,
        });
      }
      this.updateCount++;
      return;
    }

    let updatedCount = 0;
    let errorCount = 0;

    for (const [poolAddress, previousInfo] of this.monitoredPools) {
      try {
        const currentInfo = await this.shyftClient.getPoolInfo(poolAddress);
        if (!currentInfo) continue;

        // Check for changes
        if (this.hasPoolChanged(previousInfo, currentInfo)) {
          await this.emitPoolUpdate(poolAddress, previousInfo, currentInfo);
          updatedCount++;
        }

        // Update stored info
        this.monitoredPools.set(poolAddress, currentInfo);
        this.lastUpdateTime = new Date();
      } catch (error) {
        errorCount++;
        this.errorCount++;
        logger.error('Failed to poll pool', { poolAddress, error });
      }
    }

    if (updatedCount > 0 || errorCount > 0) {
      logger.debug('Poll cycle completed', {
        updated: updatedCount,
        errors: errorCount,
        total: this.monitoredPools.size,
      });
    }
  }

  /**
   * Refresh a specific pool and emit update if changed
   */
  private async refreshPoolAndEmit(poolAddress: string, slot: number): Promise<void> {
    if (!this.shyftClient.isConfigured()) return;

    try {
      const previousInfo = this.monitoredPools.get(poolAddress);
      const currentInfo = await this.shyftClient.getPoolInfo(poolAddress);

      if (!currentInfo) return;

      if (previousInfo && this.hasPoolChanged(previousInfo, currentInfo)) {
        await this.emitPoolUpdate(poolAddress, previousInfo, currentInfo, slot);
      }

      this.monitoredPools.set(poolAddress, currentInfo);
    } catch (error) {
      logger.error('Failed to refresh pool', { poolAddress, error });
    }
  }

  /**
   * Check if pool reserves have changed
   */
  private hasPoolChanged(previous: PoolInfo, current: PoolInfo): boolean {
    return previous.baseReserve !== current.baseReserve ||
           previous.quoteReserve !== current.quoteReserve;
  }

  /**
   * Emit a pool update event
   */
  private async emitPoolUpdate(
    poolAddress: string,
    previous: PoolInfo,
    current: PoolInfo,
    slot?: number
  ): Promise<void> {
    const previousBase = BigInt(previous.baseReserve);
    const previousQuote = BigInt(previous.quoteReserve);
    const currentBase = BigInt(current.baseReserve);
    const currentQuote = BigInt(current.quoteReserve);

    // Calculate price change
    let priceChange = 0;
    if (previousBase > 0n && currentBase > 0n) {
      const previousPrice = Number(previousQuote) / Number(previousBase);
      const currentPrice = Number(currentQuote) / Number(currentBase);
      priceChange = ((currentPrice - previousPrice) / previousPrice) * 100;
    }

    // Calculate liquidity change
    const previousLiquidity = Number(previousQuote);
    const currentLiquidity = Number(currentQuote);
    const liquidityChange = previousLiquidity > 0
      ? ((currentLiquidity - previousLiquidity) / previousLiquidity) * 100
      : 0;

    const update: PoolUpdate = {
      poolAddress,
      tokenMint: current.baseMint,
      quoteMint: current.quoteMint,
      dex: current.dex,
      baseReserve: currentBase,
      quoteReserve: currentQuote,
      previousBaseReserve: previousBase,
      previousQuoteReserve: previousQuote,
      priceChange,
      liquidityChange,
      slot: slot || 0,
      timestamp: new Date(),
    };

    this.updateCount++;
    this.emit('poolUpdate', update);

    // Cache the update
    if (this.cachePoolInfo) {
      await this.cachePoolUpdate(update);
    }

    // Persist to database
    await this.savePoolToDatabase(update, current);

    logger.debug('Pool update detected', {
      poolAddress: poolAddress.substring(0, 10) + '...',
      priceChange: priceChange.toFixed(2) + '%',
      liquidityChange: liquidityChange.toFixed(2) + '%',
    });
  }

  /**
   * Save pool update to database
   */
  private async savePoolToDatabase(update: PoolUpdate, poolInfo: PoolInfo): Promise<void> {
    try {
      // Get or create token record
      let tokenId = await this.tokenRepository.getTokenIdByMint(update.tokenMint);

      if (!tokenId) {
        tokenId = await this.tokenRepository.upsertToken({
          mintAddress: update.tokenMint,
          isActive: true,
        });
      }

      if (!tokenId) {
        logger.warn('Failed to get/create token for pool', { poolAddress: update.poolAddress });
        return;
      }

      // Calculate liquidity in USD (rough estimate based on SOL price)
      // In production, you'd want to get the actual SOL/USD rate
      const liquidityUsd = Number(update.quoteReserve) / 1e9 * 200; // Rough SOL price

      // Upsert pool record
      await this.poolRepository.upsertPool({
        tokenId,
        poolAddress: update.poolAddress,
        dexName: update.dex,
        baseMint: update.tokenMint,
        quoteMint: update.quoteMint,
        baseReserve: update.baseReserve.toString(),
        quoteReserve: update.quoteReserve.toString(),
        liquidityUsd,
        isActive: true,
      });
    } catch (error) {
      logger.error('Failed to save pool to database', {
        poolAddress: update.poolAddress,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Redis helpers
   */
  private async addToActivePoolsSet(poolAddress: string): Promise<void> {
    try {
      // Using cache.set for now - in production, use Redis SADD
      const key = `pools:active`;
      const pools = await cache.get<string[]>(key) || [];
      if (!pools.includes(poolAddress)) {
        pools.push(poolAddress);
        await cache.set(key, pools);
      }
    } catch (error) {
      logger.warn('Failed to add pool to active set', { poolAddress });
    }
  }

  private async removeFromActivePoolsSet(poolAddress: string): Promise<void> {
    try {
      const key = `pools:active`;
      const pools = await cache.get<string[]>(key) || [];
      const filtered = pools.filter(p => p !== poolAddress);
      await cache.set(key, filtered);
    } catch (error) {
      logger.warn('Failed to remove pool from active set', { poolAddress });
    }
  }

  private async cachePoolUpdate(update: PoolUpdate): Promise<void> {
    try {
      const key = `pool:${update.poolAddress}`;
      await cache.set(key, {
        ...update,
        baseReserve: update.baseReserve.toString(),
        quoteReserve: update.quoteReserve.toString(),
        previousBaseReserve: update.previousBaseReserve?.toString(),
        previousQuoteReserve: update.previousQuoteReserve?.toString(),
      }, this.cacheTTL);
    } catch (error) {
      logger.warn('Failed to cache pool update', { poolAddress: update.poolAddress });
    }
  }

  /**
   * Get monitor statistics
   */
  getStats(): {
    isRunning: boolean;
    monitoredPools: number;
    updateCount: number;
    mode: MonitoringMode;
  } {
    return {
      isRunning: this.isRunning,
      monitoredPools: this.monitoredPools.size,
      updateCount: this.updateCount,
      mode: this.monitoringMode,
    };
  }

  /**
   * Get detailed monitoring status for health checks
   */
  getMonitoringStatus(): MonitoringStatus {
    // Calculate health based on recent activity and error rate
    const now = new Date();
    const timeSinceLastUpdate = this.lastUpdateTime
      ? (now.getTime() - this.lastUpdateTime.getTime()) / 1000
      : Infinity;

    // Consider healthy if:
    // - Not running (disabled mode is expected)
    // - OR last update was within 5 minutes and error rate is low
    const isHealthy =
      this.monitoringMode === 'disabled' ||
      (timeSinceLastUpdate < 300 && this.errorCount < 10) ||
      (this.monitoredPools.size === 0); // No pools = nothing to monitor

    return {
      mode: this.monitoringMode,
      isHealthy,
      lastUpdateTime: this.lastUpdateTime,
      errorCount: this.errorCount,
      poolCount: this.monitoredPools.size,
      details: {
        grpcConnected: this.grpcConnected,
        shyftConfigured: this.shyftClient.isConfigured(),
        pollingActive: !!this.pollIntervalId,
      },
    };
  }

  /**
   * Check if monitoring is effectively disabled
   * Used by health checks to determine actual monitoring state
   */
  isEffectivelyDisabled(): boolean {
    return (
      this.monitoringMode === 'disabled' ||
      (!this.grpcConnected && !this.pollIntervalId && !this.shyftClient.isConfigured())
    );
  }

  /**
   * Get list of monitored pool addresses
   */
  getMonitoredPools(): string[] {
    return Array.from(this.monitoredPools.keys());
  }
}

// Export singleton instance
export const poolMonitor = new PoolMonitor();

export default PoolMonitor;
