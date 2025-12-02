import { logger } from '../../utils/logger.js';
import { getRedisClient, RedisClient } from '../../config/redis.js';

// Time windows in seconds
export const TIME_WINDOWS = {
  FIVE_MIN: 5 * 60,
  FIFTEEN_MIN: 15 * 60,
  ONE_HOUR: 60 * 60,
  FOUR_HOUR: 4 * 60 * 60,
  TWENTY_FOUR_HOUR: 24 * 60 * 60,
} as const;

export type TimeWindow = keyof typeof TIME_WINDOWS;

export interface TradeRecord {
  mintAddress: string;
  amountSol: number;
  amountUsd: number;
  type: 'buy' | 'sell';
  timestamp: number;
  txSignature?: string;
}

export interface VolumeStats {
  mintAddress: string;
  window: TimeWindow;
  windowSeconds: number;
  totalVolumeSol: number;
  totalVolumeUsd: number;
  buyVolumeSol: number;
  buyVolumeUsd: number;
  sellVolumeSol: number;
  sellVolumeUsd: number;
  tradeCount: number;
  buyCount: number;
  sellCount: number;
  lastUpdated: Date;
}

export interface VolumeAggregatorOptions {
  cleanupIntervalMs?: number;
  maxTradeAge?: number; // Maximum age in seconds to keep trades
}

export class VolumeAggregator {
  private static readonly KEY_PREFIX = 'volume:trades:';
  private static readonly STATS_PREFIX = 'volume:stats:';
  private cleanupInterval?: NodeJS.Timeout;
  private options: Required<VolumeAggregatorOptions>;

  constructor(options?: VolumeAggregatorOptions) {
    this.options = {
      cleanupIntervalMs: options?.cleanupIntervalMs || 60000, // 1 minute
      maxTradeAge: options?.maxTradeAge || TIME_WINDOWS.TWENTY_FOUR_HOUR + 3600, // 25 hours
    };
  }

  private getClient(): RedisClient {
    return getRedisClient();
  }

  /**
   * Record a new trade
   */
  async recordTrade(trade: TradeRecord): Promise<void> {
    const key = `${VolumeAggregator.KEY_PREFIX}${trade.mintAddress}`;
    const timestamp = trade.timestamp || Date.now();

    const member = JSON.stringify({
      amountSol: trade.amountSol,
      amountUsd: trade.amountUsd,
      type: trade.type,
      tx: trade.txSignature,
    });

    try {
      const client = this.getClient();

      // Add to sorted set with timestamp as score
      await client.zAdd(key, { score: timestamp, value: `${timestamp}:${member}` });

      // Set expiry on the key (25 hours to be safe)
      await client.expire(key, this.options.maxTradeAge);

      logger.debug('Trade recorded', {
        mint: trade.mintAddress,
        type: trade.type,
        amountSol: trade.amountSol,
      });
    } catch (error) {
      logger.error('Failed to record trade', {
        mint: trade.mintAddress,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  /**
   * Record multiple trades in batch
   */
  async recordTrades(trades: TradeRecord[]): Promise<void> {
    if (trades.length === 0) return;

    const client = this.getClient();

    // Group by mint address for efficient batch processing
    const grouped = new Map<string, TradeRecord[]>();

    for (const trade of trades) {
      const existing = grouped.get(trade.mintAddress) || [];
      existing.push(trade);
      grouped.set(trade.mintAddress, existing);
    }

    try {
      const multi = client.multi();

      for (const [mintAddress, mintTrades] of grouped) {
        const key = `${VolumeAggregator.KEY_PREFIX}${mintAddress}`;

        const members = mintTrades.map(trade => {
          const timestamp = trade.timestamp || Date.now();
          const member = JSON.stringify({
            amountSol: trade.amountSol,
            amountUsd: trade.amountUsd,
            type: trade.type,
            tx: trade.txSignature,
          });
          return { score: timestamp, value: `${timestamp}:${member}` };
        });

        multi.zAdd(key, members);
        multi.expire(key, this.options.maxTradeAge);
      }

      await multi.exec();
      logger.debug('Batch trades recorded', { count: trades.length });
    } catch (error) {
      logger.error('Failed to record batch trades', {
        error: (error as Error).message,
      });
      throw error;
    }
  }

  /**
   * Get volume statistics for a token in a specific time window
   */
  async getVolumeStats(
    mintAddress: string,
    window: TimeWindow = 'TWENTY_FOUR_HOUR'
  ): Promise<VolumeStats> {
    const key = `${VolumeAggregator.KEY_PREFIX}${mintAddress}`;
    const windowSeconds = TIME_WINDOWS[window];
    const now = Date.now();
    const startTime = now - windowSeconds * 1000;

    try {
      const client = this.getClient();

      // Get all trades in the time window using ZRANGEBYSCORE
      const trades = await client.zRangeByScore(key, startTime, now);

      let totalVolumeSol = 0;
      let totalVolumeUsd = 0;
      let buyVolumeSol = 0;
      let buyVolumeUsd = 0;
      let sellVolumeSol = 0;
      let sellVolumeUsd = 0;
      let buyCount = 0;
      let sellCount = 0;

      for (const tradeStr of trades) {
        try {
          // Parse the stored format: "timestamp:{json}"
          const colonIndex = tradeStr.indexOf(':');
          if (colonIndex === -1) continue;

          const jsonPart = tradeStr.substring(colonIndex + 1);
          const trade = JSON.parse(jsonPart) as {
            amountSol: number;
            amountUsd: number;
            type: 'buy' | 'sell';
          };

          totalVolumeSol += trade.amountSol;
          totalVolumeUsd += trade.amountUsd;

          if (trade.type === 'buy') {
            buyVolumeSol += trade.amountSol;
            buyVolumeUsd += trade.amountUsd;
            buyCount++;
          } else {
            sellVolumeSol += trade.amountSol;
            sellVolumeUsd += trade.amountUsd;
            sellCount++;
          }
        } catch {
          // Skip malformed entries
          continue;
        }
      }

      return {
        mintAddress,
        window,
        windowSeconds,
        totalVolumeSol,
        totalVolumeUsd,
        buyVolumeSol,
        buyVolumeUsd,
        sellVolumeSol,
        sellVolumeUsd,
        tradeCount: trades.length,
        buyCount,
        sellCount,
        lastUpdated: new Date(),
      };
    } catch (error) {
      logger.error('Failed to get volume stats', {
        mintAddress,
        window,
        error: (error as Error).message,
      });

      // Return empty stats on error
      return {
        mintAddress,
        window,
        windowSeconds,
        totalVolumeSol: 0,
        totalVolumeUsd: 0,
        buyVolumeSol: 0,
        buyVolumeUsd: 0,
        sellVolumeSol: 0,
        sellVolumeUsd: 0,
        tradeCount: 0,
        buyCount: 0,
        sellCount: 0,
        lastUpdated: new Date(),
      };
    }
  }

  /**
   * Get volume stats for multiple time windows
   */
  async getMultiWindowStats(
    mintAddress: string
  ): Promise<Record<TimeWindow, VolumeStats>> {
    const windows: TimeWindow[] = [
      'FIVE_MIN',
      'FIFTEEN_MIN',
      'ONE_HOUR',
      'FOUR_HOUR',
      'TWENTY_FOUR_HOUR',
    ];

    const results = await Promise.all(
      windows.map(window => this.getVolumeStats(mintAddress, window))
    );

    return Object.fromEntries(
      windows.map((window, index) => [window, results[index]])
    ) as Record<TimeWindow, VolumeStats>;
  }

  /**
   * Get top tokens by volume
   */
  async getTopByVolume(
    window: TimeWindow = 'TWENTY_FOUR_HOUR',
    limit: number = 100
  ): Promise<Array<{ mintAddress: string; volumeUsd: number }>> {
    // This requires scanning all volume keys - use cached stats for efficiency
    const statsPattern = `${VolumeAggregator.STATS_PREFIX}*:${window}`;

    try {
      const client = this.getClient();
      const keys = await this.scanKeys(statsPattern);
      const results: Array<{ mintAddress: string; volumeUsd: number }> = [];

      for (const key of keys) {
        const stats = await client.get(key);
        if (stats) {
          const parsed = JSON.parse(stats) as VolumeStats;
          results.push({
            mintAddress: parsed.mintAddress,
            volumeUsd: parsed.totalVolumeUsd,
          });
        }
      }

      // Sort by volume descending
      results.sort((a, b) => b.volumeUsd - a.volumeUsd);

      return results.slice(0, limit);
    } catch (error) {
      logger.error('Failed to get top by volume', {
        error: (error as Error).message,
      });
      return [];
    }
  }

  /**
   * Cache volume stats for faster retrieval
   */
  async cacheVolumeStats(stats: VolumeStats, ttl: number = 30): Promise<void> {
    const key = `${VolumeAggregator.STATS_PREFIX}${stats.mintAddress}:${stats.window}`;

    try {
      const client = this.getClient();
      await client.setEx(key, ttl, JSON.stringify(stats));
    } catch (error) {
      logger.error('Failed to cache volume stats', {
        error: (error as Error).message,
      });
    }
  }

  /**
   * Clean up old trades outside the max window
   */
  async cleanup(mintAddress?: string): Promise<number> {
    const cutoff = Date.now() - this.options.maxTradeAge * 1000;
    let totalRemoved = 0;

    try {
      const client = this.getClient();

      if (mintAddress) {
        // Clean specific token
        const key = `${VolumeAggregator.KEY_PREFIX}${mintAddress}`;
        totalRemoved = await client.zRemRangeByScore(key, '-inf', cutoff);
      } else {
        // Clean all tokens
        const keys = await this.scanKeys(`${VolumeAggregator.KEY_PREFIX}*`);

        for (const key of keys) {
          const removed = await client.zRemRangeByScore(key, '-inf', cutoff);
          totalRemoved += removed;
        }
      }

      if (totalRemoved > 0) {
        logger.debug('Cleaned up old trades', { removed: totalRemoved });
      }

      return totalRemoved;
    } catch (error) {
      logger.error('Failed to cleanup old trades', {
        error: (error as Error).message,
      });
      return 0;
    }
  }

  /**
   * Start periodic cleanup
   */
  startCleanupJob(): void {
    if (this.cleanupInterval) return;

    this.cleanupInterval = setInterval(() => {
      this.cleanup().catch(err => {
        logger.error('Cleanup job failed', { error: err.message });
      });
    }, this.options.cleanupIntervalMs);

    logger.info('Volume cleanup job started', {
      intervalMs: this.options.cleanupIntervalMs,
    });
  }

  /**
   * Stop periodic cleanup
   */
  stopCleanupJob(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
      logger.info('Volume cleanup job stopped');
    }
  }

  /**
   * Scan Redis keys matching pattern
   */
  private async scanKeys(pattern: string): Promise<string[]> {
    const client = this.getClient();
    const keys: string[] = [];

    for await (const key of client.scanIterator({ MATCH: pattern, COUNT: 100 })) {
      keys.push(key);
    }

    return keys;
  }

  /**
   * Get buy/sell ratio
   */
  static getBuySellRatio(stats: VolumeStats): number {
    if (stats.sellVolumeUsd === 0) return stats.buyVolumeUsd > 0 ? Infinity : 1;
    return stats.buyVolumeUsd / stats.sellVolumeUsd;
  }

  /**
   * Calculate volume change percentage between two stats
   */
  static getVolumeChange(current: VolumeStats, previous: VolumeStats): number {
    if (previous.totalVolumeUsd === 0) {
      return current.totalVolumeUsd > 0 ? 100 : 0;
    }
    return ((current.totalVolumeUsd - previous.totalVolumeUsd) / previous.totalVolumeUsd) * 100;
  }
}

// Export singleton instance
export const volumeAggregator = new VolumeAggregator();

export default VolumeAggregator;
