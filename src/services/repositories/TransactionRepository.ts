import { query } from '../../config/database.js';
import { logger } from '../../utils/logger.js';

export interface TransactionRecord {
  id: number;
  signature: string;
  tokenId: number;
  poolId?: number;
  txType: string;
  walletAddress?: string;
  amountToken?: string;
  amountSol?: number;
  priceAtTx?: number;
  blockTime?: Date;
  slot?: number;
}

export interface TransactionInsert {
  signature: string;
  tokenId: number;
  poolId?: number;
  txType: string;
  walletAddress?: string;
  amountToken?: string;
  amountSol?: number;
  priceAtTx?: number;
  blockTime?: Date;
  slot?: number;
}

export class TransactionRepository {
  /**
   * Insert transaction (ignore if exists)
   */
  async insertTransaction(tx: TransactionInsert): Promise<number | null> {
    try {
      const result = await query(
        `INSERT INTO transactions (
           signature, token_id, pool_id, tx_type, wallet_address,
           amount_token, amount_sol, price_at_tx, block_time, slot
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (signature) DO NOTHING
         RETURNING id`,
        [
          tx.signature,
          tx.tokenId,
          tx.poolId,
          tx.txType,
          tx.walletAddress,
          tx.amountToken,
          tx.amountSol,
          tx.priceAtTx,
          tx.blockTime,
          tx.slot,
        ]
      );

      return result.rows[0]?.id ?? null;
    } catch (error) {
      logger.error('Failed to insert transaction', {
        signature: tx.signature,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Bulk insert transactions
   */
  async insertBulk(txs: TransactionInsert[]): Promise<number> {
    if (txs.length === 0) return 0;

    try {
      const values: unknown[] = [];
      const placeholders: string[] = [];
      let paramIndex = 1;

      for (const tx of txs) {
        placeholders.push(
          `($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`
        );
        values.push(
          tx.signature,
          tx.tokenId,
          tx.poolId,
          tx.txType,
          tx.walletAddress,
          tx.amountToken,
          tx.amountSol,
          tx.priceAtTx,
          tx.blockTime,
          tx.slot
        );
      }

      const result = await query(
        `INSERT INTO transactions (
           signature, token_id, pool_id, tx_type, wallet_address,
           amount_token, amount_sol, price_at_tx, block_time, slot
         )
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (signature) DO NOTHING`,
        values
      );

      return result.rowCount ?? 0;
    } catch (error) {
      logger.error('Failed to bulk insert transactions', {
        count: txs.length,
        error: (error as Error).message,
      });
      return 0;
    }
  }

  /**
   * Check if transaction exists
   */
  async exists(signature: string): Promise<boolean> {
    try {
      const result = await query(
        'SELECT 1 FROM transactions WHERE signature = $1',
        [signature]
      );
      return result.rows.length > 0;
    } catch (error) {
      logger.error('Failed to check transaction existence', {
        signature,
        error: (error as Error).message,
      });
      return false;
    }
  }

  /**
   * Get recent transactions for a token (with optional type filter)
   */
  async getRecentTransactions(
    tokenId: number,
    limit: number = 100,
    txType?: string
  ): Promise<TransactionRecord[]> {
    try {
      let queryStr = `SELECT id, signature, token_id, pool_id, tx_type, wallet_address,
              amount_token, amount_sol, price_at_tx, block_time, slot
       FROM transactions
       WHERE token_id = $1`;
      const params: unknown[] = [tokenId];

      if (txType) {
        queryStr += ' AND tx_type = $2';
        params.push(txType);
      }

      queryStr += ' ORDER BY block_time DESC LIMIT $' + (params.length + 1);
      params.push(limit);

      const result = await query(queryStr, params);

      return result.rows.map(row => ({
        id: row.id,
        signature: row.signature,
        tokenId: row.token_id,
        poolId: row.pool_id,
        txType: row.tx_type,
        walletAddress: row.wallet_address,
        amountToken: row.amount_token,
        amountSol: row.amount_sol ? parseFloat(row.amount_sol) : undefined,
        priceAtTx: row.price_at_tx ? parseFloat(row.price_at_tx) : undefined,
        blockTime: row.block_time,
        slot: row.slot,
      }));
    } catch (error) {
      logger.error('Failed to get recent transactions', {
        tokenId,
        error: (error as Error).message,
      });
      return [];
    }
  }

  /**
   * Get transaction count for a token in last N hours
   */
  async getTransactionCount(tokenId: number, hours: number = 24): Promise<number> {
    return this.getRecentCount(tokenId, hours);
  }

  /**
   * Get transactions for a token
   */
  async getByToken(
    tokenId: number,
    limit: number = 100,
    offset: number = 0
  ): Promise<TransactionRecord[]> {
    try {
      const result = await query(
        `SELECT id, signature, token_id, pool_id, tx_type, wallet_address,
                amount_token, amount_sol, price_at_tx, block_time, slot
         FROM transactions
         WHERE token_id = $1
         ORDER BY block_time DESC
         LIMIT $2 OFFSET $3`,
        [tokenId, limit, offset]
      );

      return result.rows.map(row => ({
        id: row.id,
        signature: row.signature,
        tokenId: row.token_id,
        poolId: row.pool_id,
        txType: row.tx_type,
        walletAddress: row.wallet_address,
        amountToken: row.amount_token,
        amountSol: row.amount_sol ? parseFloat(row.amount_sol) : undefined,
        priceAtTx: row.price_at_tx ? parseFloat(row.price_at_tx) : undefined,
        blockTime: row.block_time,
        slot: row.slot,
      }));
    } catch (error) {
      logger.error('Failed to get transactions by token', {
        tokenId,
        error: (error as Error).message,
      });
      return [];
    }
  }

  /**
   * Get recent transactions count for a token
   */
  async getRecentCount(tokenId: number, hours: number = 24): Promise<number> {
    try {
      const result = await query(
        `SELECT COUNT(*) as count
         FROM transactions
         WHERE token_id = $1
           AND block_time > NOW() - INTERVAL '${hours} hours'`,
        [tokenId]
      );

      return parseInt(result.rows[0]?.count ?? '0', 10);
    } catch (error) {
      logger.error('Failed to get recent transaction count', {
        tokenId,
        error: (error as Error).message,
      });
      return 0;
    }
  }

  /**
   * Get transaction stats for a token
   */
  async getStats(tokenId: number, hours: number = 24): Promise<{
    totalCount: number;
    buyCount: number;
    sellCount: number;
    uniqueWallets: number;
  }> {
    try {
      const result = await query(
        `SELECT
           COUNT(*) as total_count,
           SUM(CASE WHEN tx_type = 'buy' THEN 1 ELSE 0 END) as buy_count,
           SUM(CASE WHEN tx_type = 'sell' THEN 1 ELSE 0 END) as sell_count,
           COUNT(DISTINCT wallet_address) as unique_wallets
         FROM transactions
         WHERE token_id = $1
           AND block_time > NOW() - INTERVAL '${hours} hours'`,
        [tokenId]
      );

      const row = result.rows[0];
      return {
        totalCount: parseInt(row?.total_count ?? '0', 10),
        buyCount: parseInt(row?.buy_count ?? '0', 10),
        sellCount: parseInt(row?.sell_count ?? '0', 10),
        uniqueWallets: parseInt(row?.unique_wallets ?? '0', 10),
      };
    } catch (error) {
      logger.error('Failed to get transaction stats', {
        tokenId,
        error: (error as Error).message,
      });
      return { totalCount: 0, buyCount: 0, sellCount: 0, uniqueWallets: 0 };
    }
  }

  /**
   * Delete old transactions
   */
  async deleteOldTransactions(retentionDays: number): Promise<number> {
    try {
      const result = await query(
        `DELETE FROM transactions
         WHERE block_time < NOW() - INTERVAL '${retentionDays} days'`,
        []
      );

      return result.rowCount ?? 0;
    } catch (error) {
      logger.error('Failed to delete old transactions', {
        retentionDays,
        error: (error as Error).message,
      });
      return 0;
    }
  }
}

export const transactionRepository = new TransactionRepository();
