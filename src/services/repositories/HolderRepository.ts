import { query } from '../../config/database.js';
import { logger } from '../../utils/logger.js';
import { HolderInfo } from '../holders/HolderScanner.js';

export interface HolderSnapshotRecord {
  id: number;
  tokenId: number;
  mintAddress: string;
  totalHolders: number;
  top10Percentage: number;
  top20Percentage: number;
  top50Percentage: number;
  giniCoefficient: number;
  topHoldersJson: object;
  snapshotTime: Date;
}

export interface HolderSnapshotInsert {
  tokenId: number;
  mintAddress: string;
  totalHolders: number;
  top10Percentage: number;
  top20Percentage: number;
  top50Percentage: number;
  giniCoefficient: number;
  topHoldersJson: object;
}

export interface TopHolderRecord {
  id: number;
  tokenId: number;
  walletAddress: string;
  balance: string;
  percentage: number;
  rank: number;
  snapshotTime: Date;
}

export class HolderRepository {
  /**
   * Insert holder snapshot
   */
  async insertHolderSnapshot(snapshot: HolderSnapshotInsert): Promise<number | null> {
    try {
      const result = await query(
        `INSERT INTO holder_snapshots (
           token_id, mint_address, total_holders,
           top_10_percentage, top_20_percentage, top_50_percentage,
           gini_coefficient, top_holders_json
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          snapshot.tokenId,
          snapshot.mintAddress,
          snapshot.totalHolders,
          snapshot.top10Percentage,
          snapshot.top20Percentage,
          snapshot.top50Percentage,
          snapshot.giniCoefficient,
          JSON.stringify(snapshot.topHoldersJson),
        ]
      );

      return result.rows[0]?.id ?? null;
    } catch (error) {
      logger.error('Failed to insert holder snapshot', {
        tokenId: snapshot.tokenId,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Insert top holders for a token
   */
  async insertTopHolders(tokenId: number, holders: HolderInfo[]): Promise<boolean> {
    if (holders.length === 0) return true;

    try {
      // Build batch insert query
      const values: unknown[] = [];
      const placeholders: string[] = [];
      let paramIndex = 1;

      for (const holder of holders) {
        placeholders.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
        values.push(
          tokenId,
          holder.address,
          holder.balanceRaw,
          holder.percentage,
          holder.rank
        );
      }

      await query(
        `INSERT INTO top_holders (token_id, wallet_address, balance, percentage, rank)
         VALUES ${placeholders.join(', ')}`,
        values
      );

      return true;
    } catch (error) {
      logger.error('Failed to insert top holders', {
        tokenId,
        count: holders.length,
        error: (error as Error).message,
      });
      return false;
    }
  }

  /**
   * Get latest holder snapshot for a token
   */
  async getLatestSnapshot(tokenId: number): Promise<HolderSnapshotRecord | null> {
    try {
      const result = await query(
        `SELECT id, token_id, mint_address, total_holders,
                top_10_percentage, top_20_percentage, top_50_percentage,
                gini_coefficient, top_holders_json, snapshot_time
         FROM holder_snapshots
         WHERE token_id = $1
         ORDER BY snapshot_time DESC
         LIMIT 1`,
        [tokenId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      return {
        id: row.id,
        tokenId: row.token_id,
        mintAddress: row.mint_address,
        totalHolders: row.total_holders,
        top10Percentage: parseFloat(row.top_10_percentage),
        top20Percentage: parseFloat(row.top_20_percentage),
        top50Percentage: parseFloat(row.top_50_percentage),
        giniCoefficient: parseFloat(row.gini_coefficient),
        topHoldersJson: row.top_holders_json,
        snapshotTime: row.snapshot_time,
      };
    } catch (error) {
      logger.error('Failed to get latest holder snapshot', {
        tokenId,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Get holder history for a token
   */
  async getSnapshotHistory(
    tokenId: number,
    hours: number = 24
  ): Promise<HolderSnapshotRecord[]> {
    try {
      const result = await query(
        `SELECT id, token_id, mint_address, total_holders,
                top_10_percentage, top_20_percentage, top_50_percentage,
                gini_coefficient, top_holders_json, snapshot_time
         FROM holder_snapshots
         WHERE token_id = $1
           AND snapshot_time > NOW() - INTERVAL '${hours} hours'
         ORDER BY snapshot_time DESC`,
        [tokenId]
      );

      return result.rows.map(row => ({
        id: row.id,
        tokenId: row.token_id,
        mintAddress: row.mint_address,
        totalHolders: row.total_holders,
        top10Percentage: parseFloat(row.top_10_percentage),
        top20Percentage: parseFloat(row.top_20_percentage),
        top50Percentage: parseFloat(row.top_50_percentage),
        giniCoefficient: parseFloat(row.gini_coefficient),
        topHoldersJson: row.top_holders_json,
        snapshotTime: row.snapshot_time,
      }));
    } catch (error) {
      logger.error('Failed to get snapshot history', {
        tokenId,
        error: (error as Error).message,
      });
      return [];
    }
  }

  /**
   * Get top holders for a token
   */
  async getTopHolders(
    tokenId: number,
    limit: number = 10
  ): Promise<TopHolderRecord[]> {
    try {
      const result = await query(
        `SELECT DISTINCT ON (wallet_address)
                id, token_id, wallet_address, balance, percentage, rank, snapshot_time
         FROM top_holders
         WHERE token_id = $1
         ORDER BY wallet_address, snapshot_time DESC`,
        [tokenId]
      );

      // Sort by rank and limit
      return result.rows
        .sort((a, b) => a.rank - b.rank)
        .slice(0, limit)
        .map(row => ({
          id: row.id,
          tokenId: row.token_id,
          walletAddress: row.wallet_address,
          balance: row.balance,
          percentage: parseFloat(row.percentage),
          rank: row.rank,
          snapshotTime: row.snapshot_time,
        }));
    } catch (error) {
      logger.error('Failed to get top holders', {
        tokenId,
        error: (error as Error).message,
      });
      return [];
    }
  }

  /**
   * Delete old holder snapshots
   */
  async deleteOldSnapshots(retentionDays: number): Promise<number> {
    try {
      // Delete old top holders first (foreign key constraint)
      await query(
        `DELETE FROM top_holders
         WHERE snapshot_time < NOW() - INTERVAL '${retentionDays} days'`,
        []
      );

      // Delete old snapshots
      const result = await query(
        `DELETE FROM holder_snapshots
         WHERE snapshot_time < NOW() - INTERVAL '${retentionDays} days'`,
        []
      );

      return result.rowCount ?? 0;
    } catch (error) {
      logger.error('Failed to delete old holder snapshots', {
        retentionDays,
        error: (error as Error).message,
      });
      return 0;
    }
  }

  /**
   * Get holder count change over time
   */
  async getHolderCountChange(tokenId: number, hours: number = 24): Promise<number | null> {
    try {
      const result = await query(
        `WITH current_count AS (
           SELECT total_holders FROM holder_snapshots
           WHERE token_id = $1
           ORDER BY snapshot_time DESC
           LIMIT 1
         ),
         old_count AS (
           SELECT total_holders FROM holder_snapshots
           WHERE token_id = $1
             AND snapshot_time <= NOW() - INTERVAL '${hours} hours'
           ORDER BY snapshot_time DESC
           LIMIT 1
         )
         SELECT
           c.total_holders as current,
           o.total_holders as old,
           (c.total_holders - o.total_holders) as change
         FROM current_count c, old_count o`,
        [tokenId]
      );

      if (result.rows.length === 0 || result.rows[0].change === null) {
        return null;
      }

      return parseInt(result.rows[0].change, 10);
    } catch (error) {
      logger.error('Failed to get holder count change', {
        tokenId,
        hours,
        error: (error as Error).message,
      });
      return null;
    }
  }
}

export const holderRepository = new HolderRepository();
