import { EventEmitter } from 'events';
import { TransactionStreamer, ParsedTransaction, LaunchPlatform } from './TransactionStreamer.js';
import { ShyftClient, TokenInfo } from '../external/ShyftClient.js';
import { logger } from '../../utils/logger.js';
import { cache } from '../../config/redis.js';

export interface NewTokenEvent {
  mint: string;
  platform: LaunchPlatform;
  signature: string;
  slot: number;
  detectedAt: Date;
  tokenInfo?: TokenInfo;
  bondingCurve?: string;
  creator?: string;
}

export interface TokenDetectorOptions {
  fetchTokenInfo?: boolean;
  platforms?: LaunchPlatform[];
  cacheTokens?: boolean;
  cacheTTL?: number;
}

export class NewTokenDetector extends EventEmitter {
  private streamer: TransactionStreamer;
  private shyftClient: ShyftClient;
  private isRunning: boolean = false;
  private tokenCount: number = 0;
  private options: Required<TokenDetectorOptions>;

  // Track recently detected tokens to avoid duplicates
  private recentTokens: Map<string, number> = new Map();
  private readonly DEDUP_WINDOW_MS = 60000; // 1 minute

  constructor(options?: TokenDetectorOptions) {
    super();
    this.streamer = new TransactionStreamer({
      platforms: options?.platforms || ['pump.fun', 'letsbonk', 'moonshot'],
    });
    this.shyftClient = new ShyftClient();
    this.options = {
      fetchTokenInfo: options?.fetchTokenInfo ?? true,
      platforms: options?.platforms || ['pump.fun', 'letsbonk', 'moonshot'],
      cacheTokens: options?.cacheTokens ?? true,
      cacheTTL: options?.cacheTTL ?? 3600, // 1 hour
    };
  }

  /**
   * Start detecting new tokens
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('NewTokenDetector is already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting NewTokenDetector...', { platforms: this.options.platforms });

    // Listen for new token events from the streamer
    this.streamer.on('newToken', async (tx) => {
      await this.handleNewToken(tx);
    });

    this.streamer.on('error', (error) => {
      this.emit('error', error);
    });

    this.streamer.on('connected', () => {
      logger.info('NewTokenDetector connected to gRPC stream');
      this.emit('connected');
    });

    this.streamer.on('disconnected', () => {
      logger.info('NewTokenDetector disconnected from gRPC stream');
      this.emit('disconnected');
    });

    // Start the transaction streamer
    await this.streamer.start();

    // Start deduplication cleanup interval
    this.startDeduplicationCleanup();
  }

  /**
   * Stop detecting new tokens
   */
  async stop(): Promise<void> {
    this.isRunning = false;
    await this.streamer.stop();
    this.streamer.removeAllListeners();
    logger.info('NewTokenDetector stopped', { totalTokens: this.tokenCount });
  }

  /**
   * Handle a new token creation event
   */
  private async handleNewToken(tx: ParsedTransaction): Promise<void> {
    if (!tx.tokenMint) {
      logger.debug('New token event without mint address', { signature: tx.signature });
      return;
    }

    // Check for duplicates
    if (this.isDuplicate(tx.tokenMint)) {
      return;
    }

    this.tokenCount++;
    const event: NewTokenEvent = {
      mint: tx.tokenMint,
      platform: tx.platform,
      signature: tx.signature,
      slot: tx.slot,
      detectedAt: new Date(),
      bondingCurve: tx.poolAddress,
      creator: tx.walletAddress,
    };

    // Fetch additional token info if enabled
    if (this.options.fetchTokenInfo && this.shyftClient.isConfigured()) {
      try {
        const tokenInfo = await this.shyftClient.getTokenInfo(tx.tokenMint);
        if (tokenInfo) {
          event.tokenInfo = tokenInfo;
        }
      } catch (error) {
        logger.warn('Failed to fetch token info', {
          mint: tx.tokenMint,
          error: (error as Error).message,
        });
      }
    }

    // Cache the token if enabled
    if (this.options.cacheTokens) {
      await this.cacheToken(event);
    }

    // Emit the new token event
    this.emit('newToken', event);

    logger.info('New token detected', {
      mint: tx.tokenMint,
      platform: tx.platform,
      name: event.tokenInfo?.name || 'Unknown',
      symbol: event.tokenInfo?.symbol || 'Unknown',
    });
  }

  /**
   * Check if a token was recently detected (dedupe)
   */
  private isDuplicate(mint: string): boolean {
    const lastSeen = this.recentTokens.get(mint);
    if (lastSeen && Date.now() - lastSeen < this.DEDUP_WINDOW_MS) {
      return true;
    }
    this.recentTokens.set(mint, Date.now());
    return false;
  }

  /**
   * Start cleanup interval for deduplication map
   */
  private startDeduplicationCleanup(): void {
    setInterval(() => {
      const cutoff = Date.now() - this.DEDUP_WINDOW_MS;
      for (const [mint, timestamp] of this.recentTokens) {
        if (timestamp < cutoff) {
          this.recentTokens.delete(mint);
        }
      }
    }, this.DEDUP_WINDOW_MS);
  }

  /**
   * Cache token information in Redis
   */
  private async cacheToken(event: NewTokenEvent): Promise<void> {
    try {
      const key = `token:new:${event.mint}`;
      await cache.set(key, event, this.options.cacheTTL);
    } catch (error) {
      logger.warn('Failed to cache token', {
        mint: event.mint,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Get a recently detected token from cache
   */
  async getRecentToken(mint: string): Promise<NewTokenEvent | null> {
    try {
      const key = `token:new:${mint}`;
      return await cache.get<NewTokenEvent>(key);
    } catch (error) {
      return null;
    }
  }

  /**
   * Get detector statistics
   */
  getStats(): {
    isRunning: boolean;
    tokenCount: number;
    recentTokensInMemory: number;
  } {
    return {
      isRunning: this.isRunning,
      tokenCount: this.tokenCount,
      recentTokensInMemory: this.recentTokens.size,
    };
  }
}

// Factory function for creating platform-specific detectors
export function createPumpFunDetector(options?: Omit<TokenDetectorOptions, 'platforms'>): NewTokenDetector {
  return new NewTokenDetector({ ...options, platforms: ['pump.fun'] });
}

export function createLetsBonkDetector(options?: Omit<TokenDetectorOptions, 'platforms'>): NewTokenDetector {
  return new NewTokenDetector({ ...options, platforms: ['letsbonk'] });
}

export function createMoonshotDetector(options?: Omit<TokenDetectorOptions, 'platforms'>): NewTokenDetector {
  return new NewTokenDetector({ ...options, platforms: ['moonshot'] });
}

// Export singleton instance for all platforms
export const newTokenDetector = new NewTokenDetector();

export default NewTokenDetector;
