import { logger } from '../../utils/logger.js';
import { query } from '../../config/database.js';
import {
  addJob,
  addBulkJobs,
  QUEUE_NAMES,
  PRIORITIES,
  PriceFetchJob,
  HolderScanJob,
  VolumeAggregateJob,
  CleanupJob,
} from '../queue/QueueManager.js';

/**
 * Token age tier definitions for update intervals
 * Based on PRD requirements for different token lifecycle phases
 *
 * PRD Requirements:
 * - New tokens need very frequent updates for launch monitoring
 * - Price delay should be < 1 second for critical tokens (handled by real-time stream)
 * - Scheduled updates serve as backup and for non-streamed data (holders, etc.)
 */
export const TOKEN_AGE_TIERS = {
  // New tokens (< 1 hour): Very frequent updates for launch monitoring
  NEW: {
    maxAgeHours: 1,
    priceIntervalSec: 30,       // 30 seconds - critical for new launches
    holderIntervalSec: 120,     // 2 minutes - track early holder accumulation
    volumeIntervalSec: 30,      // 30 seconds
    priority: 5,
  },
  // Active tokens (1-24 hours): Frequent updates during initial activity
  ACTIVE: {
    maxAgeHours: 24,
    priceIntervalSec: 60,       // 1 minute
    holderIntervalSec: 300,     // 5 minutes
    volumeIntervalSec: 60,      // 1 minute
    priority: 3,
  },
  // Established tokens (1-7 days): Moderate updates
  ESTABLISHED: {
    maxAgeHours: 168, // 7 days
    priceIntervalSec: 300,      // 5 minutes
    holderIntervalSec: 1800,    // 30 minutes
    volumeIntervalSec: 300,     // 5 minutes
    priority: 2,
  },
  // Mature tokens (> 7 days): Less frequent updates
  MATURE: {
    maxAgeHours: Infinity,
    priceIntervalSec: 3600,     // 1 hour
    holderIntervalSec: 7200,    // 2 hours
    volumeIntervalSec: 600,     // 10 minutes
    priority: 1,
  },
} as const;

export type TokenAgeTier = keyof typeof TOKEN_AGE_TIERS;

export interface SchedulerOptions {
  schedulerTickMs?: number;           // Default: 10s - how often scheduler tick runs
  volumeAggregateIntervalMs?: number; // Default: 30s - baseline for volume checks
  cleanupIntervalMs?: number;         // Default: 1 hour
  batchSize?: number;                 // Default: 100
}

export interface MonitoredToken {
  tokenId: number;
  mintAddress: string;
  priority: number;
  updateIntervalSec: number;
  lastPriceUpdate: Date | null;
  lastHolderUpdate: Date | null;
  createdAt: Date;
  ageTier: TokenAgeTier;
  ageHours: number;
}

export class TokenScheduler {
  private isRunning: boolean = false;
  private tickIntervalId?: NodeJS.Timeout;
  private volumeIntervalId?: NodeJS.Timeout;
  private cleanupIntervalId?: NodeJS.Timeout;
  private options: Required<SchedulerOptions>;
  private lastTierUpdate: Date = new Date(0);

  constructor(options?: SchedulerOptions) {
    this.options = {
      schedulerTickMs: options?.schedulerTickMs ?? 10_000,           // 10 seconds
      volumeAggregateIntervalMs: options?.volumeAggregateIntervalMs ?? 30_000, // 30 seconds
      cleanupIntervalMs: options?.cleanupIntervalMs ?? 3600_000,     // 1 hour
      batchSize: options?.batchSize ?? 100,
    };
  }

  /**
   * Determine token age tier based on creation time
   */
  static getAgeTier(createdAt: Date): TokenAgeTier {
    const ageMs = Date.now() - createdAt.getTime();
    const ageHours = ageMs / (1000 * 60 * 60);

    if (ageHours < TOKEN_AGE_TIERS.NEW.maxAgeHours) return 'NEW';
    if (ageHours < TOKEN_AGE_TIERS.ACTIVE.maxAgeHours) return 'ACTIVE';
    if (ageHours < TOKEN_AGE_TIERS.ESTABLISHED.maxAgeHours) return 'ESTABLISHED';
    return 'MATURE';
  }

  /**
   * Get update intervals for a token based on its age tier
   */
  static getIntervalsForTier(tier: TokenAgeTier): {
    priceIntervalSec: number;
    holderIntervalSec: number;
    volumeIntervalSec: number;
    priority: number;
  } {
    return TOKEN_AGE_TIERS[tier];
  }

  /**
   * Start the scheduler
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('TokenScheduler is already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting TokenScheduler with age-based intervals', {
      tickInterval: this.options.schedulerTickMs,
      volumeInterval: this.options.volumeAggregateIntervalMs,
      cleanupInterval: this.options.cleanupIntervalMs,
      tiers: Object.keys(TOKEN_AGE_TIERS),
    });

    // Main scheduler tick - checks which tokens need updates based on their age tier
    this.tickIntervalId = setInterval(() => {
      this.runSchedulerTick().catch(err => {
        logger.error('Scheduler tick failed', { error: err.message });
      });
    }, this.options.schedulerTickMs);

    // Volume aggregation runs on its own interval (frequent)
    this.volumeIntervalId = setInterval(() => {
      this.scheduleVolumeAggregates().catch(err => {
        logger.error('Volume aggregate scheduling failed', { error: err.message });
      });
    }, this.options.volumeAggregateIntervalMs);

    // Cleanup scheduler (hourly)
    this.cleanupIntervalId = setInterval(() => {
      this.scheduleCleanup().catch(err => {
        logger.error('Cleanup scheduling failed', { error: err.message });
      });
    }, this.options.cleanupIntervalMs);

    // Run initial tick
    this.runSchedulerTick();
    this.scheduleVolumeAggregates();

    // Update token tiers periodically (every 5 minutes)
    this.updateTokenTiers();

    logger.info('TokenScheduler started');
  }

  /**
   * Stop the scheduler
   */
  stop(): void {
    this.isRunning = false;

    if (this.tickIntervalId) {
      clearInterval(this.tickIntervalId);
      this.tickIntervalId = undefined;
    }
    if (this.volumeIntervalId) {
      clearInterval(this.volumeIntervalId);
      this.volumeIntervalId = undefined;
    }
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = undefined;
    }

    logger.info('TokenScheduler stopped');
  }

  /**
   * Main scheduler tick - schedules both price and holder updates based on age tier
   */
  private async runSchedulerTick(): Promise<void> {
    const [priceTokens, holderTokens] = await Promise.all([
      this.getTokensNeedingPriceUpdate(),
      this.getTokensNeedingHolderScan(),
    ]);

    // Update token tiers if needed (every 5 minutes)
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    if (this.lastTierUpdate < fiveMinutesAgo) {
      this.updateTokenTiers();
    }

    // Schedule price updates
    if (priceTokens.length > 0) {
      await this.schedulePriceUpdates(priceTokens);
    }

    // Schedule holder scans
    if (holderTokens.length > 0) {
      await this.scheduleHolderScans(holderTokens);
    }
  }

  /**
   * Get tokens that need price updates based on their age tier intervals
   */
  private async getTokensNeedingPriceUpdate(): Promise<MonitoredToken[]> {
    try {
      // Query tokens with their age and determine if they need updates
      // Uses the tier-specific interval from the tier configuration
      const result = await query(
        `SELECT
           mt.token_id,
           t.mint_address,
           mt.priority,
           mt.update_interval_sec,
           mt.last_price_update,
           mt.last_holder_update,
           t.created_at,
           EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 3600 as age_hours
         FROM monitored_tokens mt
         JOIN tokens t ON t.id = mt.token_id
         WHERE t.is_active = true
           AND (
             mt.last_price_update IS NULL
             OR (
               -- Use dynamic interval based on age
               CASE
                 WHEN EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 3600 < 1 THEN
                   mt.last_price_update < NOW() - INTERVAL '${TOKEN_AGE_TIERS.NEW.priceIntervalSec} seconds'
                 WHEN EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 3600 < 24 THEN
                   mt.last_price_update < NOW() - INTERVAL '${TOKEN_AGE_TIERS.ACTIVE.priceIntervalSec} seconds'
                 WHEN EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 3600 < 168 THEN
                   mt.last_price_update < NOW() - INTERVAL '${TOKEN_AGE_TIERS.ESTABLISHED.priceIntervalSec} seconds'
                 ELSE
                   mt.last_price_update < NOW() - INTERVAL '${TOKEN_AGE_TIERS.MATURE.priceIntervalSec} seconds'
               END
             )
           )
         ORDER BY
           CASE
             WHEN EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 3600 < 1 THEN 0
             WHEN EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 3600 < 24 THEN 1
             ELSE 2
           END,
           mt.priority DESC,
           mt.last_price_update ASC NULLS FIRST
         LIMIT $1`,
        [this.options.batchSize]
      );

      return result.rows.map(row => {
        const ageHours = parseFloat(row.age_hours);
        const ageTier = TokenScheduler.getAgeTier(new Date(row.created_at));
        return {
          tokenId: row.token_id,
          mintAddress: row.mint_address,
          priority: row.priority,
          updateIntervalSec: row.update_interval_sec,
          lastPriceUpdate: row.last_price_update,
          lastHolderUpdate: row.last_holder_update,
          createdAt: row.created_at,
          ageTier,
          ageHours,
        };
      });
    } catch (error) {
      logger.error('Failed to get tokens for price update', {
        error: (error as Error).message,
      });
      return [];
    }
  }

  /**
   * Get tokens that need holder scans based on their age tier intervals
   */
  private async getTokensNeedingHolderScan(): Promise<MonitoredToken[]> {
    try {
      const result = await query(
        `SELECT
           mt.token_id,
           t.mint_address,
           mt.priority,
           mt.update_interval_sec,
           mt.last_price_update,
           mt.last_holder_update,
           t.created_at,
           EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 3600 as age_hours
         FROM monitored_tokens mt
         JOIN tokens t ON t.id = mt.token_id
         WHERE t.is_active = true
           AND (
             mt.last_holder_update IS NULL
             OR (
               CASE
                 WHEN EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 3600 < 1 THEN
                   mt.last_holder_update < NOW() - INTERVAL '${TOKEN_AGE_TIERS.NEW.holderIntervalSec} seconds'
                 WHEN EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 3600 < 24 THEN
                   mt.last_holder_update < NOW() - INTERVAL '${TOKEN_AGE_TIERS.ACTIVE.holderIntervalSec} seconds'
                 WHEN EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 3600 < 168 THEN
                   mt.last_holder_update < NOW() - INTERVAL '${TOKEN_AGE_TIERS.ESTABLISHED.holderIntervalSec} seconds'
                 ELSE
                   mt.last_holder_update < NOW() - INTERVAL '${TOKEN_AGE_TIERS.MATURE.holderIntervalSec} seconds'
               END
             )
           )
         ORDER BY
           CASE
             WHEN EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 3600 < 1 THEN 0
             ELSE 1
           END,
           mt.priority DESC,
           mt.last_holder_update ASC NULLS FIRST
         LIMIT $1`,
        [Math.floor(this.options.batchSize / 2)] // Holder scans are expensive, use smaller batch
      );

      return result.rows.map(row => {
        const ageHours = parseFloat(row.age_hours);
        const ageTier = TokenScheduler.getAgeTier(new Date(row.created_at));
        return {
          tokenId: row.token_id,
          mintAddress: row.mint_address,
          priority: row.priority,
          updateIntervalSec: row.update_interval_sec,
          lastPriceUpdate: row.last_price_update,
          lastHolderUpdate: row.last_holder_update,
          createdAt: row.created_at,
          ageTier,
          ageHours,
        };
      });
    } catch (error) {
      logger.error('Failed to get tokens for holder scan', {
        error: (error as Error).message,
      });
      return [];
    }
  }

  /**
   * Get all active tokens for volume aggregation
   */
  private async getActiveTokens(): Promise<string[]> {
    try {
      const result = await query(
        `SELECT t.mint_address
         FROM monitored_tokens mt
         JOIN tokens t ON t.id = mt.token_id
         WHERE t.is_active = true
         ORDER BY mt.priority DESC
         LIMIT $1`,
        [this.options.batchSize * 2]
      );

      return result.rows.map(row => row.mint_address);
    } catch (error) {
      logger.error('Failed to get active tokens', {
        error: (error as Error).message,
      });
      return [];
    }
  }

  /**
   * Schedule price update jobs grouped by priority
   */
  private async schedulePriceUpdates(tokens: MonitoredToken[]): Promise<void> {
    if (tokens.length === 0) return;

    // Group by tier for logging
    const tierCounts: Record<TokenAgeTier, number> = { NEW: 0, ACTIVE: 0, ESTABLISHED: 0, MATURE: 0 };
    tokens.forEach(t => tierCounts[t.ageTier]++);

    // Group by priority level (NEW tokens get CRITICAL, others by their priority)
    const criticalTokens = tokens.filter(t => t.ageTier === 'NEW');
    const highPriority = tokens.filter(t => t.ageTier === 'ACTIVE');
    const normalPriority = tokens.filter(t => t.ageTier !== 'NEW' && t.ageTier !== 'ACTIVE');

    // Enqueue critical (new) tokens individually for fastest processing
    for (const token of criticalTokens) {
      await addJob<PriceFetchJob>(
        QUEUE_NAMES.PRICE_FETCH,
        'price-new-token',
        {
          mintAddresses: [token.mintAddress],
          priority: PRIORITIES.CRITICAL,
        },
        PRIORITIES.CRITICAL
      );
    }

    // Enqueue high priority tokens individually
    for (const token of highPriority) {
      await addJob<PriceFetchJob>(
        QUEUE_NAMES.PRICE_FETCH,
        'price-active',
        {
          mintAddresses: [token.mintAddress],
          priority: PRIORITIES.HIGH,
        },
        PRIORITIES.HIGH
      );
    }

    // Batch normal priority tokens
    if (normalPriority.length > 0) {
      const mintAddresses = normalPriority.map(t => t.mintAddress);
      await addJob<PriceFetchJob>(
        QUEUE_NAMES.PRICE_FETCH,
        'price-batch',
        {
          mintAddresses,
          priority: PRIORITIES.NORMAL,
        },
        PRIORITIES.NORMAL
      );
    }

    // Update timestamps
    await this.updatePriceTimestamps(tokens.map(t => t.tokenId));

    logger.debug('Price updates scheduled by age tier', {
      total: tokens.length,
      tiers: tierCounts,
    });
  }

  /**
   * Schedule holder scan jobs
   */
  private async scheduleHolderScans(tokens: MonitoredToken[]): Promise<void> {
    if (tokens.length === 0) return;

    const jobs = tokens.map(token => {
      const tierConfig = TOKEN_AGE_TIERS[token.ageTier];
      return {
        name: `holder-scan-${token.ageTier.toLowerCase()}`,
        data: {
          mintAddress: token.mintAddress,
          priority: tierConfig.priority >= 4 ? PRIORITIES.HIGH : PRIORITIES.NORMAL,
          takeSnapshot: true,
        } as HolderScanJob,
        priority: tierConfig.priority >= 4 ? PRIORITIES.HIGH : PRIORITIES.NORMAL,
      };
    });

    await addBulkJobs(QUEUE_NAMES.HOLDER_SCAN, jobs);
    await this.updateHolderTimestamps(tokens.map(t => t.tokenId));

    logger.debug('Holder scans scheduled', { count: tokens.length });
  }

  /**
   * Schedule volume aggregate jobs
   */
  private async scheduleVolumeAggregates(): Promise<void> {
    const mintAddresses = await this.getActiveTokens();

    if (mintAddresses.length === 0) {
      return;
    }

    const jobs = mintAddresses.map(mintAddress => ({
      name: 'volume-aggregate',
      data: {
        mintAddress,
        priority: PRIORITIES.NORMAL,
      } as VolumeAggregateJob,
      priority: PRIORITIES.LOW,
    }));

    await addBulkJobs(QUEUE_NAMES.VOLUME_AGGREGATE, jobs);

    logger.debug('Volume aggregates scheduled', { count: mintAddresses.length });
  }

  /**
   * Schedule cleanup job
   */
  private async scheduleCleanup(): Promise<void> {
    await addJob<CleanupJob>(
      QUEUE_NAMES.CLEANUP,
      'scheduled-cleanup',
      {
        type: 'all',
        retentionDays: 30,
      },
      PRIORITIES.BACKGROUND
    );

    logger.debug('Cleanup job scheduled');
  }

  /**
   * Update monitored_tokens with appropriate intervals based on token age
   * This runs periodically to adjust intervals as tokens age
   */
  private async updateTokenTiers(): Promise<void> {
    try {
      // Update intervals based on current age
      await query(`
        UPDATE monitored_tokens mt
        SET
          priority = CASE
            WHEN EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 3600 < 1 THEN ${TOKEN_AGE_TIERS.NEW.priority}
            WHEN EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 3600 < 24 THEN ${TOKEN_AGE_TIERS.ACTIVE.priority}
            WHEN EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 3600 < 168 THEN ${TOKEN_AGE_TIERS.ESTABLISHED.priority}
            ELSE ${TOKEN_AGE_TIERS.MATURE.priority}
          END,
          update_interval_sec = CASE
            WHEN EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 3600 < 1 THEN ${TOKEN_AGE_TIERS.NEW.priceIntervalSec}
            WHEN EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 3600 < 24 THEN ${TOKEN_AGE_TIERS.ACTIVE.priceIntervalSec}
            WHEN EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 3600 < 168 THEN ${TOKEN_AGE_TIERS.ESTABLISHED.priceIntervalSec}
            ELSE ${TOKEN_AGE_TIERS.MATURE.priceIntervalSec}
          END
        FROM tokens t
        WHERE mt.token_id = t.id AND t.is_active = true
      `, []);

      this.lastTierUpdate = new Date();
      logger.debug('Token tiers updated based on age');
    } catch (error) {
      logger.error('Failed to update token tiers', {
        error: (error as Error).message,
      });
    }
  }

  /**
   * Update last_price_update timestamps
   */
  private async updatePriceTimestamps(tokenIds: number[]): Promise<void> {
    if (tokenIds.length === 0) return;

    try {
      await query(
        `UPDATE monitored_tokens
         SET last_price_update = NOW()
         WHERE token_id = ANY($1)`,
        [tokenIds]
      );
    } catch (error) {
      logger.error('Failed to update price timestamps', {
        error: (error as Error).message,
      });
    }
  }

  /**
   * Update last_holder_update timestamps
   */
  private async updateHolderTimestamps(tokenIds: number[]): Promise<void> {
    if (tokenIds.length === 0) return;

    try {
      await query(
        `UPDATE monitored_tokens
         SET last_holder_update = NOW()
         WHERE token_id = ANY($1)`,
        [tokenIds]
      );
    } catch (error) {
      logger.error('Failed to update holder timestamps', {
        error: (error as Error).message,
      });
    }
  }

  /**
   * Manually trigger all schedules (for testing)
   */
  async triggerAll(): Promise<void> {
    await this.runSchedulerTick();
    await this.scheduleVolumeAggregates();
  }

  /**
   * Add a token to monitoring with automatic age-based tier assignment
   */
  async addTokenToMonitoring(
    mintAddress: string,
    priorityOverride?: number,
    updateIntervalSecOverride?: number
  ): Promise<boolean> {
    try {
      // First ensure token exists and get its created_at
      const tokenResult = await query(
        `INSERT INTO tokens (mint_address, is_active)
         VALUES ($1, true)
         ON CONFLICT (mint_address) DO UPDATE SET is_active = true
         RETURNING id, created_at`,
        [mintAddress]
      );

      const tokenId = tokenResult.rows[0]?.id;
      const createdAt = tokenResult.rows[0]?.created_at || new Date();
      if (!tokenId) return false;

      // Determine tier based on age
      const ageTier = TokenScheduler.getAgeTier(createdAt);
      const tierConfig = TOKEN_AGE_TIERS[ageTier];

      const priority = priorityOverride ?? tierConfig.priority;
      const updateIntervalSec = updateIntervalSecOverride ?? tierConfig.priceIntervalSec;

      // Add to monitored_tokens
      await query(
        `INSERT INTO monitored_tokens (token_id, priority, update_interval_sec)
         VALUES ($1, $2, $3)
         ON CONFLICT (token_id) DO UPDATE SET
           priority = EXCLUDED.priority,
           update_interval_sec = EXCLUDED.update_interval_sec`,
        [tokenId, priority, updateIntervalSec]
      );

      logger.info('Token added to monitoring with age-based tier', {
        mintAddress,
        ageTier,
        priority,
        updateIntervalSec,
      });
      return true;
    } catch (error) {
      logger.error('Failed to add token to monitoring', {
        mintAddress,
        error: (error as Error).message,
      });
      return false;
    }
  }

  /**
   * Remove a token from monitoring
   */
  async removeTokenFromMonitoring(mintAddress: string): Promise<boolean> {
    try {
      await query(
        `DELETE FROM monitored_tokens
         WHERE token_id = (SELECT id FROM tokens WHERE mint_address = $1)`,
        [mintAddress]
      );

      logger.info('Token removed from monitoring', { mintAddress });
      return true;
    } catch (error) {
      logger.error('Failed to remove token from monitoring', {
        mintAddress,
        error: (error as Error).message,
      });
      return false;
    }
  }

  /**
   * Get scheduler status including tier information
   */
  getStatus(): {
    isRunning: boolean;
    intervals: {
      tick: number;
      volume: number;
      cleanup: number;
    };
    tiers: typeof TOKEN_AGE_TIERS;
  } {
    return {
      isRunning: this.isRunning,
      intervals: {
        tick: this.options.schedulerTickMs,
        volume: this.options.volumeAggregateIntervalMs,
        cleanup: this.options.cleanupIntervalMs,
      },
      tiers: TOKEN_AGE_TIERS,
    };
  }
}

// Export singleton instance
export const tokenScheduler = new TokenScheduler();

export default TokenScheduler;
