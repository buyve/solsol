import { logger } from '../../utils/logger.js';
import { pool } from '../../config/database.js';
import { holderScanner, HolderAnalysis, HolderInfo } from './HolderScanner.js';

export interface SnapshotRecord {
  id: number;
  mintAddress: string;
  totalHolders: number;
  top10Percentage: number;
  top20Percentage: number;
  top50Percentage: number;
  giniCoefficient: number;
  topHoldersJson: string;
  snapshotTime: Date;
}

export interface HolderChange {
  mintAddress: string;
  previousSnapshot: SnapshotRecord | null;
  currentSnapshot: SnapshotRecord;
  holderCountChange: number;
  top10Change: number;
  giniChange: number;
  newHolders: string[];
  exitedHolders: string[];
}

export class HolderSnapshot {
  /**
   * Take a snapshot of current holder distribution
   */
  async takeSnapshot(mintAddress: string): Promise<SnapshotRecord | null> {
    try {
      const analysis = await holderScanner.analyzeHolders(mintAddress);

      if (!analysis) {
        logger.warn('No holder analysis available for snapshot', { mintAddress });
        return null;
      }

      // Store in database
      const result = await pool.query<SnapshotRecord>(
        `INSERT INTO holder_snapshots
         (mint_address, total_holders, top_10_percentage, top_20_percentage,
          top_50_percentage, gini_coefficient, top_holders_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, mint_address as "mintAddress", total_holders as "totalHolders",
                   top_10_percentage as "top10Percentage", top_20_percentage as "top20Percentage",
                   top_50_percentage as "top50Percentage", gini_coefficient as "giniCoefficient",
                   top_holders_json as "topHoldersJson", snapshot_time as "snapshotTime"`,
        [
          mintAddress,
          analysis.totalHolders,
          analysis.top10Percentage,
          analysis.top20Percentage,
          analysis.top50Percentage,
          analysis.giniCoefficient,
          JSON.stringify(analysis.holders.slice(0, 50)),
        ]
      );

      logger.debug('Holder snapshot taken', {
        mint: mintAddress,
        holders: analysis.totalHolders,
      });

      return result.rows[0];
    } catch (error) {
      logger.error('Failed to take holder snapshot', {
        mintAddress,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Get latest snapshot for a token
   */
  async getLatestSnapshot(mintAddress: string): Promise<SnapshotRecord | null> {
    try {
      const result = await pool.query<SnapshotRecord>(
        `SELECT id, mint_address as "mintAddress", total_holders as "totalHolders",
                top_10_percentage as "top10Percentage", top_20_percentage as "top20Percentage",
                top_50_percentage as "top50Percentage", gini_coefficient as "giniCoefficient",
                top_holders_json as "topHoldersJson", snapshot_time as "snapshotTime"
         FROM holder_snapshots
         WHERE mint_address = $1
         ORDER BY snapshot_time DESC
         LIMIT 1`,
        [mintAddress]
      );

      return result.rows[0] || null;
    } catch (error) {
      logger.error('Failed to get latest snapshot', {
        mintAddress,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Get snapshot history for a token
   */
  async getSnapshotHistory(
    mintAddress: string,
    limit: number = 24
  ): Promise<SnapshotRecord[]> {
    try {
      const result = await pool.query<SnapshotRecord>(
        `SELECT id, mint_address as "mintAddress", total_holders as "totalHolders",
                top_10_percentage as "top10Percentage", top_20_percentage as "top20Percentage",
                top_50_percentage as "top50Percentage", gini_coefficient as "giniCoefficient",
                top_holders_json as "topHoldersJson", snapshot_time as "snapshotTime"
         FROM holder_snapshots
         WHERE mint_address = $1
         ORDER BY snapshot_time DESC
         LIMIT $2`,
        [mintAddress, limit]
      );

      return result.rows;
    } catch (error) {
      logger.error('Failed to get snapshot history', {
        mintAddress,
        error: (error as Error).message,
      });
      return [];
    }
  }

  /**
   * Compare current state with previous snapshot
   */
  async compareWithPrevious(mintAddress: string): Promise<HolderChange | null> {
    try {
      // Get previous snapshot
      const previousSnapshot = await this.getLatestSnapshot(mintAddress);

      // Take new snapshot
      const currentSnapshot = await this.takeSnapshot(mintAddress);

      if (!currentSnapshot) {
        return null;
      }

      // Parse previous holders
      const previousHolders: string[] = previousSnapshot
        ? (JSON.parse(previousSnapshot.topHoldersJson) as HolderInfo[]).map(h => h.address)
        : [];

      // Parse current holders
      const currentHolders: HolderInfo[] = JSON.parse(currentSnapshot.topHoldersJson);
      const currentAddresses = currentHolders.map(h => h.address);

      // Find new and exited holders
      const newHolders = currentAddresses.filter(a => !previousHolders.includes(a));
      const exitedHolders = previousHolders.filter(a => !currentAddresses.includes(a));

      return {
        mintAddress,
        previousSnapshot,
        currentSnapshot,
        holderCountChange: previousSnapshot
          ? currentSnapshot.totalHolders - previousSnapshot.totalHolders
          : currentSnapshot.totalHolders,
        top10Change: previousSnapshot
          ? currentSnapshot.top10Percentage - previousSnapshot.top10Percentage
          : 0,
        giniChange: previousSnapshot
          ? currentSnapshot.giniCoefficient - previousSnapshot.giniCoefficient
          : 0,
        newHolders,
        exitedHolders,
      };
    } catch (error) {
      logger.error('Failed to compare snapshots', {
        mintAddress,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Get tokens with significant holder changes
   */
  async getTokensWithSignificantChanges(
    thresholdPercent: number = 10
  ): Promise<Array<{ mintAddress: string; change: number }>> {
    try {
      const result = await pool.query<{ mintAddress: string; change: number }>(
        `WITH recent_snapshots AS (
           SELECT mint_address, top_10_percentage, snapshot_time,
                  LAG(top_10_percentage) OVER (PARTITION BY mint_address ORDER BY snapshot_time) as prev_top10
           FROM holder_snapshots
           WHERE snapshot_time > NOW() - INTERVAL '24 hours'
         )
         SELECT mint_address as "mintAddress",
                (top_10_percentage - prev_top10) as change
         FROM recent_snapshots
         WHERE prev_top10 IS NOT NULL
           AND ABS(top_10_percentage - prev_top10) > $1
         ORDER BY ABS(top_10_percentage - prev_top10) DESC
         LIMIT 100`,
        [thresholdPercent]
      );

      return result.rows;
    } catch (error) {
      logger.error('Failed to get tokens with significant changes', {
        error: (error as Error).message,
      });
      return [];
    }
  }

  /**
   * Clean up old snapshots
   */
  async cleanupOldSnapshots(retentionDays: number = 7): Promise<number> {
    try {
      const result = await pool.query(
        `DELETE FROM holder_snapshots
         WHERE snapshot_time < NOW() - INTERVAL '1 day' * $1
         RETURNING id`,
        [retentionDays]
      );

      const deletedCount = result.rowCount || 0;

      if (deletedCount > 0) {
        logger.info('Cleaned up old holder snapshots', { deleted: deletedCount });
      }

      return deletedCount;
    } catch (error) {
      logger.error('Failed to cleanup old snapshots', {
        error: (error as Error).message,
      });
      return 0;
    }
  }

  /**
   * Get holder growth rate
   */
  async getHolderGrowthRate(
    mintAddress: string,
    hoursBack: number = 24
  ): Promise<number | null> {
    try {
      const result = await pool.query<{ oldest: number; newest: number }>(
        `WITH bounds AS (
           SELECT
             (SELECT total_holders FROM holder_snapshots
              WHERE mint_address = $1
              AND snapshot_time > NOW() - INTERVAL '1 hour' * $2
              ORDER BY snapshot_time ASC LIMIT 1) as oldest,
             (SELECT total_holders FROM holder_snapshots
              WHERE mint_address = $1
              ORDER BY snapshot_time DESC LIMIT 1) as newest
         )
         SELECT oldest, newest FROM bounds`,
        [mintAddress, hoursBack]
      );

      const { oldest, newest } = result.rows[0] || {};

      if (!oldest || !newest || oldest === 0) {
        return null;
      }

      return ((newest - oldest) / oldest) * 100;
    } catch (error) {
      logger.error('Failed to get holder growth rate', {
        mintAddress,
        error: (error as Error).message,
      });
      return null;
    }
  }
}

// Export singleton instance
export const holderSnapshot = new HolderSnapshot();

export default HolderSnapshot;
