import { EventEmitter } from 'events';
import { SubscribeUpdate, SubscribeRequest, CommitmentLevel } from '@triton-one/yellowstone-grpc';
import { GrpcClient, PROGRAM_IDS } from '../external/GrpcClient.js';
import { ShyftClient, PoolInfo } from '../external/ShyftClient.js';
import { logger } from '../../utils/logger.js';
import { cache } from '../../config/redis.js';
import { bytesToBase58 } from '../../utils/solana.js';

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
}

export class PoolMonitor extends EventEmitter {
  private grpcClient: GrpcClient;
  private shyftClient: ShyftClient;
  private isRunning: boolean = false;
  private monitoredPools: Map<string, PoolInfo> = new Map();
  private updateCount: number = 0;
  private pollIntervalMs: number;
  private pollIntervalId?: NodeJS.Timeout;
  private cachePoolInfo: boolean;
  private cacheTTL: number;

  constructor(options?: PoolMonitorOptions) {
    super();
    this.grpcClient = new GrpcClient();
    this.shyftClient = new ShyftClient();
    this.pollIntervalMs = options?.pollIntervalMs ?? 5000; // 5 seconds default
    this.cachePoolInfo = options?.cachePoolInfo ?? true;
    this.cacheTTL = options?.cacheTTL ?? 300; // 5 minutes
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
    logger.info('Starting PoolMonitor...');

    // If gRPC is configured, use real-time monitoring
    if (this.grpcClient.isConfigured()) {
      await this.startGrpcMonitoring();
    } else {
      // Fall back to polling
      this.startPolling();
    }

    this.emit('started');
  }

  /**
   * Stop monitoring
   */
  async stop(): Promise<void> {
    this.isRunning = false;

    if (this.pollIntervalId) {
      clearInterval(this.pollIntervalId);
    }

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

      // Add to Redis set for persistence
      await this.addToActivePoolsSet(poolAddress);

      logger.info('Pool added to monitoring', {
        poolAddress,
        dex: poolInfo.dex,
        baseMint: poolInfo.baseMint,
      });

      return true;
    } catch (error) {
      logger.error('Failed to add pool', { poolAddress, error });
      return false;
    }
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
   * Start gRPC-based real-time monitoring
   */
  private async startGrpcMonitoring(): Promise<void> {
    try {
      await this.grpcClient.connect();

      // For now, we subscribe to all DEX program transactions
      // and filter for our monitored pools
      const request = this.buildAccountSubscription();

      await this.grpcClient.subscribe(request, async (update) => {
        await this.handleAccountUpdate(update);
      });
    } catch (error) {
      logger.error('gRPC monitoring failed, falling back to polling', { error });
      this.startPolling();
    }
  }

  /**
   * Build account subscription request
   */
  private buildAccountSubscription(): SubscribeRequest {
    // Subscribe to all DEX program transactions to detect pool changes
    return {
      accounts: {},
      slots: {},
      transactions: {
        raydium_amm: {
          vote: false,
          failed: false,
          accountInclude: [PROGRAM_IDS.RAYDIUM_AMM_V4],
          accountExclude: [],
          accountRequired: [],
        },
        raydium_cpmm: {
          vote: false,
          failed: false,
          accountInclude: [PROGRAM_IDS.RAYDIUM_CPMM],
          accountExclude: [],
          accountRequired: [],
        },
        pumpswap: {
          vote: false,
          failed: false,
          accountInclude: [PROGRAM_IDS.PUMP_SWAP_AMM],
          accountExclude: [],
          accountRequired: [],
        },
        orca: {
          vote: false,
          failed: false,
          accountInclude: [PROGRAM_IDS.ORCA_WHIRLPOOL],
          accountExclude: [],
          accountRequired: [],
        },
      },
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
    // Process transaction to find pool account changes
    if (!update.transaction) return;

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
    if (!this.shyftClient.isConfigured()) return;

    for (const [poolAddress, previousInfo] of this.monitoredPools) {
      try {
        const currentInfo = await this.shyftClient.getPoolInfo(poolAddress);
        if (!currentInfo) continue;

        // Check for changes
        if (this.hasPoolChanged(previousInfo, currentInfo)) {
          await this.emitPoolUpdate(poolAddress, previousInfo, currentInfo);
        }

        // Update stored info
        this.monitoredPools.set(poolAddress, currentInfo);
      } catch (error) {
        logger.error('Failed to poll pool', { poolAddress, error });
      }
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

    logger.debug('Pool update detected', {
      poolAddress: poolAddress.substring(0, 10) + '...',
      priceChange: priceChange.toFixed(2) + '%',
      liquidityChange: liquidityChange.toFixed(2) + '%',
    });
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
  } {
    return {
      isRunning: this.isRunning,
      monitoredPools: this.monitoredPools.size,
      updateCount: this.updateCount,
    };
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
