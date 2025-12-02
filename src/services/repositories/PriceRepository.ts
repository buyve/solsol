import { query } from '../../config/database.js';
import { logger } from '../../utils/logger.js';

export interface PriceRecord {
  id: number;
  tokenId: number;
  priceSol: number;
  priceUsd: number;
  solUsdRate: number;
  timestamp: Date;
}

export interface PriceInsert {
  tokenId: number;
  priceSol: number;
  priceUsd: number;
  solUsdRate: number;
}

export interface MarketCapRecord {
  id: number;
  tokenId: number;
  marketCapUsd: number;
  fdvUsd: number;
  circulatingSupply: string;
  timestamp: Date;
}

export interface MarketCapInsert {
  tokenId: number;
  marketCapUsd: number;
  fdvUsd: number;
  circulatingSupply: string;
}

export class PriceRepository {
  /**
   * Insert price record
   */
  async insertPrice(price: PriceInsert): Promise<number | null> {
    try {
      const result = await query(
        `INSERT INTO price_history (token_id, price_sol, price_usd, sol_usd_rate)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [price.tokenId, price.priceSol, price.priceUsd, price.solUsdRate]
      );

      return result.rows[0]?.id ?? null;
    } catch (error) {
      logger.error('Failed to insert price', {
        tokenId: price.tokenId,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Get latest price for a token
   */
  async getLatestPrice(tokenId: number): Promise<PriceRecord | null> {
    try {
      const result = await query(
        `SELECT id, token_id, price_sol, price_usd, sol_usd_rate, timestamp
         FROM price_history
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
        priceSol: parseFloat(row.price_sol),
        priceUsd: parseFloat(row.price_usd),
        solUsdRate: parseFloat(row.sol_usd_rate),
        timestamp: row.timestamp,
      };
    } catch (error) {
      logger.error('Failed to get latest price', {
        tokenId,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Get price history for a token
   */
  async getPriceHistory(
    tokenId: number,
    hours: number = 24,
    interval: string = '1 hour'
  ): Promise<PriceRecord[]> {
    try {
      const result = await query(
        `SELECT id, token_id, price_sol, price_usd, sol_usd_rate, timestamp
         FROM price_history
         WHERE token_id = $1
           AND timestamp > NOW() - INTERVAL '${hours} hours'
         ORDER BY timestamp DESC`,
        [tokenId]
      );

      return result.rows.map(row => ({
        id: row.id,
        tokenId: row.token_id,
        priceSol: parseFloat(row.price_sol),
        priceUsd: parseFloat(row.price_usd),
        solUsdRate: parseFloat(row.sol_usd_rate),
        timestamp: row.timestamp,
      }));
    } catch (error) {
      logger.error('Failed to get price history', {
        tokenId,
        error: (error as Error).message,
      });
      return [];
    }
  }

  /**
   * Insert market cap record
   */
  async insertMarketCap(marketCap: MarketCapInsert): Promise<number | null> {
    try {
      const result = await query(
        `INSERT INTO market_cap_history (token_id, market_cap_usd, fdv_usd, circulating_supply)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [
          marketCap.tokenId,
          marketCap.marketCapUsd,
          marketCap.fdvUsd,
          marketCap.circulatingSupply,
        ]
      );

      return result.rows[0]?.id ?? null;
    } catch (error) {
      logger.error('Failed to insert market cap', {
        tokenId: marketCap.tokenId,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Get latest market cap for a token
   */
  async getLatestMarketCap(tokenId: number): Promise<MarketCapRecord | null> {
    try {
      const result = await query(
        `SELECT id, token_id, market_cap_usd, fdv_usd, circulating_supply, timestamp
         FROM market_cap_history
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
        marketCapUsd: parseFloat(row.market_cap_usd),
        fdvUsd: parseFloat(row.fdv_usd),
        circulatingSupply: row.circulating_supply,
        timestamp: row.timestamp,
      };
    } catch (error) {
      logger.error('Failed to get latest market cap', {
        tokenId,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Delete old price records
   */
  async deleteOldPrices(retentionDays: number): Promise<number> {
    try {
      const result = await query(
        `DELETE FROM price_history
         WHERE timestamp < NOW() - INTERVAL '${retentionDays} days'`,
        []
      );

      return result.rowCount ?? 0;
    } catch (error) {
      logger.error('Failed to delete old prices', {
        retentionDays,
        error: (error as Error).message,
      });
      return 0;
    }
  }

  /**
   * Delete old market cap records
   */
  async deleteOldMarketCaps(retentionDays: number): Promise<number> {
    try {
      const result = await query(
        `DELETE FROM market_cap_history
         WHERE timestamp < NOW() - INTERVAL '${retentionDays} days'`,
        []
      );

      return result.rowCount ?? 0;
    } catch (error) {
      logger.error('Failed to delete old market caps', {
        retentionDays,
        error: (error as Error).message,
      });
      return 0;
    }
  }

  /**
   * Get price change percentage over a time period
   */
  async getPriceChange(tokenId: number, hours: number = 24): Promise<number | null> {
    try {
      const result = await query(
        `WITH current_price AS (
           SELECT price_usd FROM price_history
           WHERE token_id = $1
           ORDER BY timestamp DESC
           LIMIT 1
         ),
         old_price AS (
           SELECT price_usd FROM price_history
           WHERE token_id = $1
             AND timestamp <= NOW() - INTERVAL '${hours} hours'
           ORDER BY timestamp DESC
           LIMIT 1
         )
         SELECT
           c.price_usd as current,
           o.price_usd as old,
           CASE WHEN o.price_usd > 0
             THEN ((c.price_usd - o.price_usd) / o.price_usd * 100)
             ELSE NULL
           END as change_pct
         FROM current_price c, old_price o`,
        [tokenId]
      );

      if (result.rows.length === 0 || result.rows[0].change_pct === null) {
        return null;
      }

      return parseFloat(result.rows[0].change_pct);
    } catch (error) {
      logger.error('Failed to get price change', {
        tokenId,
        hours,
        error: (error as Error).message,
      });
      return null;
    }
  }
}

export const priceRepository = new PriceRepository();
