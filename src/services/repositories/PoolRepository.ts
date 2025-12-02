import { query } from '../../config/database.js';
import { logger } from '../../utils/logger.js';

export interface PoolRecord {
  id: number;
  tokenId: number;
  poolAddress: string;
  dexName: string;
  baseMint: string;
  quoteMint: string;
  baseReserve: string;
  quoteReserve: string;
  liquidityUsd: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PoolInsert {
  tokenId: number;
  poolAddress: string;
  dexName: string;
  baseMint: string;
  quoteMint: string;
  baseReserve?: string;
  quoteReserve?: string;
  liquidityUsd?: number;
  isActive?: boolean;
}

export class PoolRepository {
  /**
   * Upsert pool (insert or update)
   */
  async upsertPool(pool: PoolInsert): Promise<number | null> {
    try {
      const result = await query(
        `INSERT INTO liquidity_pools (
           token_id, pool_address, dex_name, base_mint, quote_mint,
           base_reserve, quote_reserve, liquidity_usd, is_active
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (pool_address)
         DO UPDATE SET
           base_reserve = COALESCE(EXCLUDED.base_reserve, liquidity_pools.base_reserve),
           quote_reserve = COALESCE(EXCLUDED.quote_reserve, liquidity_pools.quote_reserve),
           liquidity_usd = COALESCE(EXCLUDED.liquidity_usd, liquidity_pools.liquidity_usd),
           is_active = COALESCE(EXCLUDED.is_active, liquidity_pools.is_active),
           updated_at = NOW()
         RETURNING id`,
        [
          pool.tokenId,
          pool.poolAddress,
          pool.dexName,
          pool.baseMint,
          pool.quoteMint,
          pool.baseReserve,
          pool.quoteReserve,
          pool.liquidityUsd,
          pool.isActive ?? true,
        ]
      );

      return result.rows[0]?.id ?? null;
    } catch (error) {
      logger.error('Failed to upsert pool', {
        poolAddress: pool.poolAddress,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Get pool by address
   */
  async getByAddress(poolAddress: string): Promise<PoolRecord | null> {
    try {
      const result = await query(
        `SELECT id, token_id, pool_address, dex_name, base_mint, quote_mint,
                base_reserve, quote_reserve, liquidity_usd, is_active,
                created_at, updated_at
         FROM liquidity_pools
         WHERE pool_address = $1`,
        [poolAddress]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      return {
        id: row.id,
        tokenId: row.token_id,
        poolAddress: row.pool_address,
        dexName: row.dex_name,
        baseMint: row.base_mint,
        quoteMint: row.quote_mint,
        baseReserve: row.base_reserve,
        quoteReserve: row.quote_reserve,
        liquidityUsd: parseFloat(row.liquidity_usd || '0'),
        isActive: row.is_active,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    } catch (error) {
      logger.error('Failed to get pool', {
        poolAddress,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Get pools for a token
   */
  async getPoolsByToken(tokenId: number): Promise<PoolRecord[]> {
    try {
      const result = await query(
        `SELECT id, token_id, pool_address, dex_name, base_mint, quote_mint,
                base_reserve, quote_reserve, liquidity_usd, is_active,
                created_at, updated_at
         FROM liquidity_pools
         WHERE token_id = $1 AND is_active = true
         ORDER BY liquidity_usd DESC`,
        [tokenId]
      );

      return result.rows.map(row => ({
        id: row.id,
        tokenId: row.token_id,
        poolAddress: row.pool_address,
        dexName: row.dex_name,
        baseMint: row.base_mint,
        quoteMint: row.quote_mint,
        baseReserve: row.base_reserve,
        quoteReserve: row.quote_reserve,
        liquidityUsd: parseFloat(row.liquidity_usd || '0'),
        isActive: row.is_active,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    } catch (error) {
      logger.error('Failed to get pools for token', {
        tokenId,
        error: (error as Error).message,
      });
      return [];
    }
  }

  /**
   * Update pool reserves
   */
  async updateReserves(
    poolAddress: string,
    baseReserve: string,
    quoteReserve: string,
    liquidityUsd?: number
  ): Promise<boolean> {
    try {
      await query(
        `UPDATE liquidity_pools
         SET base_reserve = $1, quote_reserve = $2, liquidity_usd = $3, updated_at = NOW()
         WHERE pool_address = $4`,
        [baseReserve, quoteReserve, liquidityUsd, poolAddress]
      );
      return true;
    } catch (error) {
      logger.error('Failed to update pool reserves', {
        poolAddress,
        error: (error as Error).message,
      });
      return false;
    }
  }

  /**
   * Set pool inactive
   */
  async setInactive(poolAddress: string): Promise<boolean> {
    try {
      await query(
        `UPDATE liquidity_pools SET is_active = false, updated_at = NOW()
         WHERE pool_address = $1`,
        [poolAddress]
      );
      return true;
    } catch (error) {
      logger.error('Failed to set pool inactive', {
        poolAddress,
        error: (error as Error).message,
      });
      return false;
    }
  }

  /**
   * Get all active pools
   */
  async getActivePools(limit: number = 1000): Promise<PoolRecord[]> {
    try {
      const result = await query(
        `SELECT id, token_id, pool_address, dex_name, base_mint, quote_mint,
                base_reserve, quote_reserve, liquidity_usd, is_active,
                created_at, updated_at
         FROM liquidity_pools
         WHERE is_active = true
         ORDER BY liquidity_usd DESC
         LIMIT $1`,
        [limit]
      );

      return result.rows.map(row => ({
        id: row.id,
        tokenId: row.token_id,
        poolAddress: row.pool_address,
        dexName: row.dex_name,
        baseMint: row.base_mint,
        quoteMint: row.quote_mint,
        baseReserve: row.base_reserve,
        quoteReserve: row.quote_reserve,
        liquidityUsd: parseFloat(row.liquidity_usd || '0'),
        isActive: row.is_active,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    } catch (error) {
      logger.error('Failed to get active pools', {
        error: (error as Error).message,
      });
      return [];
    }
  }

  /**
   * Get total liquidity by DEX
   */
  async getTotalLiquidityByDex(): Promise<Array<{ dex: string; totalLiquidity: number; poolCount: number }>> {
    try {
      const result = await query(
        `SELECT dex_name, SUM(liquidity_usd) as total_liquidity, COUNT(*) as pool_count
         FROM liquidity_pools
         WHERE is_active = true
         GROUP BY dex_name
         ORDER BY total_liquidity DESC`,
        []
      );

      return result.rows.map(row => ({
        dex: row.dex_name,
        totalLiquidity: parseFloat(row.total_liquidity || '0'),
        poolCount: parseInt(row.pool_count, 10),
      }));
    } catch (error) {
      logger.error('Failed to get total liquidity by DEX', {
        error: (error as Error).message,
      });
      return [];
    }
  }
}

export const poolRepository = new PoolRepository();
