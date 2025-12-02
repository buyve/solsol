import { query } from '../../config/database.js';
import { logger } from '../../utils/logger.js';

export interface VolumeStatsRecord {
  id: number;
  tokenId: number;
  volume24hSol: number;
  volume24hUsd: number;
  buyCount24h: number;
  sellCount24h: number;
  buyVolume24hSol: number;
  sellVolume24hSol: number;
  timestamp: Date;
}

export interface VolumeStatsInsert {
  tokenId: number;
  volume24hSol: number;
  volume24hUsd: number;
  buyCount24h: number;
  sellCount24h: number;
  buyVolume24hSol: number;
  sellVolume24hSol: number;
}

export class VolumeRepository {
  /**
   * Insert volume stats
   */
  async insertVolumeStats(stats: VolumeStatsInsert): Promise<number | null> {
    try {
      const result = await query(
        `INSERT INTO volume_stats (
           token_id, volume_24h_sol, volume_24h_usd,
           buy_count_24h, sell_count_24h,
           buy_volume_24h_sol, sell_volume_24h_sol
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          stats.tokenId,
          stats.volume24hSol,
          stats.volume24hUsd,
          stats.buyCount24h,
          stats.sellCount24h,
          stats.buyVolume24hSol,
          stats.sellVolume24hSol,
        ]
      );

      return result.rows[0]?.id ?? null;
    } catch (error) {
      logger.error('Failed to insert volume stats', {
        tokenId: stats.tokenId,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Get latest volume stats for a token
   */
  async getLatestStats(tokenId: number): Promise<VolumeStatsRecord | null> {
    try {
      const result = await query(
        `SELECT id, token_id, volume_24h_sol, volume_24h_usd,
                buy_count_24h, sell_count_24h,
                buy_volume_24h_sol, sell_volume_24h_sol, timestamp
         FROM volume_stats
         WHERE token_id = $1
         ORDER BY timestamp DESC
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
        volume24hSol: parseFloat(row.volume_24h_sol),
        volume24hUsd: parseFloat(row.volume_24h_usd),
        buyCount24h: row.buy_count_24h,
        sellCount24h: row.sell_count_24h,
        buyVolume24hSol: parseFloat(row.buy_volume_24h_sol),
        sellVolume24hSol: parseFloat(row.sell_volume_24h_sol),
        timestamp: row.timestamp,
      };
    } catch (error) {
      logger.error('Failed to get latest volume stats', {
        tokenId,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Get volume history for a token
   */
  async getVolumeHistory(
    tokenId: number,
    hours: number = 24
  ): Promise<VolumeStatsRecord[]> {
    try {
      const result = await query(
        `SELECT id, token_id, volume_24h_sol, volume_24h_usd,
                buy_count_24h, sell_count_24h,
                buy_volume_24h_sol, sell_volume_24h_sol, timestamp
         FROM volume_stats
         WHERE token_id = $1
           AND timestamp > NOW() - INTERVAL '${hours} hours'
         ORDER BY timestamp DESC`,
        [tokenId]
      );

      return result.rows.map(row => ({
        id: row.id,
        tokenId: row.token_id,
        volume24hSol: parseFloat(row.volume_24h_sol),
        volume24hUsd: parseFloat(row.volume_24h_usd),
        buyCount24h: row.buy_count_24h,
        sellCount24h: row.sell_count_24h,
        buyVolume24hSol: parseFloat(row.buy_volume_24h_sol),
        sellVolume24hSol: parseFloat(row.sell_volume_24h_sol),
        timestamp: row.timestamp,
      }));
    } catch (error) {
      logger.error('Failed to get volume history', {
        tokenId,
        error: (error as Error).message,
      });
      return [];
    }
  }

  /**
   * Get latest volume (alias for getLatestStats)
   */
  async getLatestVolume(tokenId: number): Promise<VolumeStatsRecord | null> {
    return this.getLatestStats(tokenId);
  }

  /**
   * Get top tokens by volume
   */
  async getTopByVolume(hours: number = 24, limit: number = 100): Promise<Array<{
    tokenId: number;
    mintAddress: string;
    volume24hUsd: number;
    buyCount24h: number;
    sellCount24h: number;
  }>> {
    try {
      const result = await query(
        `SELECT DISTINCT ON (vs.token_id)
                vs.token_id, t.mint_address, vs.volume_24h_usd,
                vs.buy_count_24h, vs.sell_count_24h
         FROM volume_stats vs
         JOIN tokens t ON t.id = vs.token_id
         WHERE vs.timestamp > NOW() - INTERVAL '1 hour'
         ORDER BY vs.token_id, vs.timestamp DESC`,
        []
      );

      // Sort by volume and limit
      return result.rows
        .sort((a, b) => parseFloat(b.volume_24h_usd) - parseFloat(a.volume_24h_usd))
        .slice(0, limit)
        .map(row => ({
          tokenId: row.token_id,
          mintAddress: row.mint_address,
          volume24hUsd: parseFloat(row.volume_24h_usd),
          buyCount24h: row.buy_count_24h,
          sellCount24h: row.sell_count_24h,
        }));
    } catch (error) {
      logger.error('Failed to get top by volume', {
        error: (error as Error).message,
      });
      return [];
    }
  }

  /**
   * Delete old volume stats
   */
  async deleteOldStats(retentionDays: number): Promise<number> {
    try {
      const result = await query(
        `DELETE FROM volume_stats
         WHERE timestamp < NOW() - INTERVAL '${retentionDays} days'`,
        []
      );

      return result.rowCount ?? 0;
    } catch (error) {
      logger.error('Failed to delete old volume stats', {
        retentionDays,
        error: (error as Error).message,
      });
      return 0;
    }
  }

  /**
   * Get buy/sell ratio for a token
   */
  async getBuySellRatio(tokenId: number): Promise<number | null> {
    try {
      const stats = await this.getLatestStats(tokenId);

      if (!stats || stats.sellVolume24hSol === 0) {
        return stats?.buyVolume24hSol ?? null;
      }

      return stats.buyVolume24hSol / stats.sellVolume24hSol;
    } catch (error) {
      logger.error('Failed to get buy/sell ratio', {
        tokenId,
        error: (error as Error).message,
      });
      return null;
    }
  }
}

export const volumeRepository = new VolumeRepository();
