import { query } from '../../config/database.js';
import { logger } from '../../utils/logger.js';

export interface TokenRecord {
  id: number;
  mintAddress: string;
  name?: string;
  symbol?: string;
  decimals: number;
  totalSupply?: string;
  metadataUri?: string;
  launchPlatform?: string;
  createdAt: Date;
  updatedAt: Date;
  isActive: boolean;
}

export interface TokenInsert {
  mintAddress: string;
  name?: string;
  symbol?: string;
  decimals?: number;
  totalSupply?: string;
  metadataUri?: string;
  launchPlatform?: string;
  isActive?: boolean;
}

export class TokenRepository {
  /**
   * Get token ID by mint address
   */
  async getTokenIdByMint(mintAddress: string): Promise<number | null> {
    try {
      const result = await query(
        'SELECT id FROM tokens WHERE mint_address = $1',
        [mintAddress]
      );

      return result.rows[0]?.id ?? null;
    } catch (error) {
      logger.error('Failed to get token ID', {
        mintAddress,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Get token by mint address
   */
  async getByMint(mintAddress: string): Promise<TokenRecord | null> {
    try {
      const result = await query(
        `SELECT id, mint_address, name, symbol, decimals, total_supply,
                metadata_uri, launch_platform, created_at, updated_at, is_active
         FROM tokens WHERE mint_address = $1`,
        [mintAddress]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      return {
        id: row.id,
        mintAddress: row.mint_address,
        name: row.name,
        symbol: row.symbol,
        decimals: row.decimals,
        totalSupply: row.total_supply,
        metadataUri: row.metadata_uri,
        launchPlatform: row.launch_platform,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        isActive: row.is_active,
      };
    } catch (error) {
      logger.error('Failed to get token', {
        mintAddress,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Upsert token (insert or update)
   */
  async upsertToken(token: TokenInsert): Promise<number | null> {
    try {
      const result = await query(
        `INSERT INTO tokens (mint_address, name, symbol, decimals, total_supply,
                            metadata_uri, launch_platform, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (mint_address)
         DO UPDATE SET
           name = COALESCE(EXCLUDED.name, tokens.name),
           symbol = COALESCE(EXCLUDED.symbol, tokens.symbol),
           decimals = COALESCE(EXCLUDED.decimals, tokens.decimals),
           total_supply = COALESCE(EXCLUDED.total_supply, tokens.total_supply),
           metadata_uri = COALESCE(EXCLUDED.metadata_uri, tokens.metadata_uri),
           launch_platform = COALESCE(EXCLUDED.launch_platform, tokens.launch_platform),
           is_active = COALESCE(EXCLUDED.is_active, tokens.is_active),
           updated_at = NOW()
         RETURNING id`,
        [
          token.mintAddress,
          token.name,
          token.symbol,
          token.decimals ?? 9,
          token.totalSupply,
          token.metadataUri,
          token.launchPlatform,
          token.isActive ?? true,
        ]
      );

      return result.rows[0]?.id ?? null;
    } catch (error) {
      logger.error('Failed to upsert token', {
        mintAddress: token.mintAddress,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Update token metadata
   */
  async updateMetadata(
    mintAddress: string,
    metadata: Partial<TokenInsert>
  ): Promise<boolean> {
    try {
      const updates: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      if (metadata.name !== undefined) {
        updates.push(`name = $${paramIndex++}`);
        values.push(metadata.name);
      }
      if (metadata.symbol !== undefined) {
        updates.push(`symbol = $${paramIndex++}`);
        values.push(metadata.symbol);
      }
      if (metadata.decimals !== undefined) {
        updates.push(`decimals = $${paramIndex++}`);
        values.push(metadata.decimals);
      }
      if (metadata.totalSupply !== undefined) {
        updates.push(`total_supply = $${paramIndex++}`);
        values.push(metadata.totalSupply);
      }
      if (metadata.metadataUri !== undefined) {
        updates.push(`metadata_uri = $${paramIndex++}`);
        values.push(metadata.metadataUri);
      }
      if (metadata.launchPlatform !== undefined) {
        updates.push(`launch_platform = $${paramIndex++}`);
        values.push(metadata.launchPlatform);
      }
      if (metadata.isActive !== undefined) {
        updates.push(`is_active = $${paramIndex++}`);
        values.push(metadata.isActive);
      }

      if (updates.length === 0) {
        return true;
      }

      values.push(mintAddress);

      await query(
        `UPDATE tokens SET ${updates.join(', ')}, updated_at = NOW()
         WHERE mint_address = $${paramIndex}`,
        values
      );

      return true;
    } catch (error) {
      logger.error('Failed to update token metadata', {
        mintAddress,
        error: (error as Error).message,
      });
      return false;
    }
  }

  /**
   * Get active tokens for monitoring
   */
  async getActiveTokens(limit: number = 1000): Promise<TokenRecord[]> {
    try {
      const result = await query(
        `SELECT t.id, t.mint_address, t.name, t.symbol, t.decimals, t.total_supply,
                t.metadata_uri, t.launch_platform, t.created_at, t.updated_at, t.is_active
         FROM tokens t
         JOIN monitored_tokens mt ON mt.token_id = t.id
         WHERE t.is_active = true
         ORDER BY mt.priority DESC
         LIMIT $1`,
        [limit]
      );

      return result.rows.map(row => ({
        id: row.id,
        mintAddress: row.mint_address,
        name: row.name,
        symbol: row.symbol,
        decimals: row.decimals,
        totalSupply: row.total_supply,
        metadataUri: row.metadata_uri,
        launchPlatform: row.launch_platform,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        isActive: row.is_active,
      }));
    } catch (error) {
      logger.error('Failed to get active tokens', {
        error: (error as Error).message,
      });
      return [];
    }
  }

  /**
   * Add token to monitoring
   */
  async addToMonitoring(
    tokenId: number,
    priority: number = 1,
    updateIntervalSec: number = 60
  ): Promise<boolean> {
    try {
      await query(
        `INSERT INTO monitored_tokens (token_id, priority, update_interval_sec)
         VALUES ($1, $2, $3)
         ON CONFLICT (token_id) DO UPDATE SET
           priority = EXCLUDED.priority,
           update_interval_sec = EXCLUDED.update_interval_sec`,
        [tokenId, priority, updateIntervalSec]
      );
      return true;
    } catch (error) {
      logger.error('Failed to add token to monitoring', {
        tokenId,
        error: (error as Error).message,
      });
      return false;
    }
  }

  /**
   * Remove token from monitoring
   */
  async removeFromMonitoring(tokenId: number): Promise<boolean> {
    try {
      await query(
        'DELETE FROM monitored_tokens WHERE token_id = $1',
        [tokenId]
      );
      return true;
    } catch (error) {
      logger.error('Failed to remove token from monitoring', {
        tokenId,
        error: (error as Error).message,
      });
      return false;
    }
  }

  /**
   * Update token market cap (stores latest values on token record for quick access)
   */
  async updateTokenMarketCap(
    tokenId: number,
    marketCapUsd: number,
    fdvUsd: number
  ): Promise<boolean> {
    try {
      await query(
        `UPDATE tokens SET
           market_cap_usd = $2,
           fdv_usd = $3,
           updated_at = NOW()
         WHERE id = $1`,
        [tokenId, marketCapUsd, fdvUsd]
      );
      return true;
    } catch (error) {
      logger.error('Failed to update token market cap', {
        tokenId,
        error: (error as Error).message,
      });
      return false;
    }
  }

  /**
   * Get token by ID
   */
  async getById(tokenId: number): Promise<TokenRecord | null> {
    try {
      const result = await query(
        `SELECT id, mint_address, name, symbol, decimals, total_supply,
                metadata_uri, launch_platform, created_at, updated_at, is_active
         FROM tokens WHERE id = $1`,
        [tokenId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      return {
        id: row.id,
        mintAddress: row.mint_address,
        name: row.name,
        symbol: row.symbol,
        decimals: row.decimals,
        totalSupply: row.total_supply,
        metadataUri: row.metadata_uri,
        launchPlatform: row.launch_platform,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        isActive: row.is_active,
      };
    } catch (error) {
      logger.error('Failed to get token by ID', {
        tokenId,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Search tokens by name or symbol
   */
  async searchTokens(searchTerm: string, limit: number = 20): Promise<TokenRecord[]> {
    try {
      const result = await query(
        `SELECT id, mint_address, name, symbol, decimals, total_supply,
                metadata_uri, launch_platform, created_at, updated_at, is_active
         FROM tokens
         WHERE name ILIKE $1 OR symbol ILIKE $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [`%${searchTerm}%`, limit]
      );

      return result.rows.map(row => ({
        id: row.id,
        mintAddress: row.mint_address,
        name: row.name,
        symbol: row.symbol,
        decimals: row.decimals,
        totalSupply: row.total_supply,
        metadataUri: row.metadata_uri,
        launchPlatform: row.launch_platform,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        isActive: row.is_active,
      }));
    } catch (error) {
      logger.error('Failed to search tokens', {
        searchTerm,
        error: (error as Error).message,
      });
      return [];
    }
  }

  /**
   * Get recent tokens
   */
  async getRecentTokens(hours: number = 24, limit: number = 100): Promise<TokenRecord[]> {
    try {
      const result = await query(
        `SELECT id, mint_address, name, symbol, decimals, total_supply,
                metadata_uri, launch_platform, created_at, updated_at, is_active
         FROM tokens
         WHERE created_at > NOW() - INTERVAL '${hours} hours'
         ORDER BY created_at DESC
         LIMIT $1`,
        [limit]
      );

      return result.rows.map(row => ({
        id: row.id,
        mintAddress: row.mint_address,
        name: row.name,
        symbol: row.symbol,
        decimals: row.decimals,
        totalSupply: row.total_supply,
        metadataUri: row.metadata_uri,
        launchPlatform: row.launch_platform,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        isActive: row.is_active,
      }));
    } catch (error) {
      logger.error('Failed to get recent tokens', {
        hours,
        error: (error as Error).message,
      });
      return [];
    }
  }
}

export const tokenRepository = new TokenRepository();
