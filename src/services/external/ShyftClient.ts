import { ShyftSdk, Network } from '@shyft-to/js';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';

// Types
export interface TokenInfo {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: string;
  metadataUri?: string;
  image?: string;
}

export interface TokenHolder {
  address: string;
  balance: string;
  percentage?: number;
}

export interface PoolInfo {
  poolAddress: string;
  dex: string;
  baseMint: string;
  quoteMint: string;
  baseReserve: string;
  quoteReserve: string;
  liquidityUsd?: number;
}

export interface ShyftClientOptions {
  apiKey: string;
  network?: Network;
  maxRetries?: number;
  retryDelayMs?: number;
}

// API Response types
interface ShyftApiResponse<T> {
  success: boolean;
  message?: string;
  result?: T;
}

interface ShyftDefiResponse {
  pools?: PoolApiResponse[];
  pool?: PoolApiResponse;
}

interface PoolApiResponse {
  address?: string;
  pool_address?: string;
  dex?: string;
  source?: string;
  token_a?: { address: string; amount?: string };
  token_b?: { address: string; amount?: string };
  base_mint?: string;
  quote_mint?: string;
  base_reserve?: string;
  quote_reserve?: string;
  liquidity_usd?: number;
  tvl?: number;
}

interface HolderApiResponse {
  owner: string;
  balance: string;
}

export class ShyftClient {
  private sdk: ShyftSdk;
  private apiKey: string;
  private maxRetries: number;
  private retryDelayMs: number;

  constructor(options?: Partial<ShyftClientOptions>) {
    this.apiKey = options?.apiKey || config.shyft.apiKey;
    this.maxRetries = options?.maxRetries || 3;
    this.retryDelayMs = options?.retryDelayMs || 1000;

    if (!this.apiKey) {
      logger.warn('Shyft API key is not configured');
    }

    this.sdk = new ShyftSdk({
      apiKey: this.apiKey,
      network: options?.network || Network.Mainnet,
    });
  }

  /**
   * Execute a function with exponential backoff retry logic
   */
  private async withRetry<T>(
    operation: () => Promise<T>,
    operationName: string
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;
        const delay = this.retryDelayMs * Math.pow(2, attempt - 1);

        logger.warn(`${operationName} failed (attempt ${attempt}/${this.maxRetries})`, {
          error: lastError.message,
          nextRetryIn: attempt < this.maxRetries ? `${delay}ms` : 'no more retries',
        });

        if (attempt < this.maxRetries) {
          await this.sleep(delay);
        }
      }
    }

    throw lastError;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get token information by mint address
   */
  async getTokenInfo(mintAddress: string): Promise<TokenInfo | null> {
    return this.withRetry(async () => {
      const response = await fetch(
        `https://api.shyft.to/sol/v1/token/get_info?network=mainnet-beta&token_address=${mintAddress}`,
        {
          headers: { 'x-api-key': this.apiKey },
        }
      );

      if (!response.ok) {
        if (response.status === 404) {
          return null;
        }
        throw new Error(`Shyft API error: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as ShyftApiResponse<{
        address: string;
        name?: string;
        symbol?: string;
        decimals?: number;
        current_supply?: string;
        metadata_uri?: string;
        image?: string;
      }>;

      if (!data.success || !data.result) {
        return null;
      }

      const result = data.result;
      return {
        address: result.address,
        name: result.name || '',
        symbol: result.symbol || '',
        decimals: result.decimals || 9,
        totalSupply: result.current_supply?.toString() || '0',
        metadataUri: result.metadata_uri,
        image: result.image,
      };
    }, `getTokenInfo(${mintAddress})`);
  }

  /**
   * Get all holders of a token with pagination (using REST API)
   */
  async getAllHolders(
    mintAddress: string,
    options?: { maxPages?: number; pageSize?: number }
  ): Promise<TokenHolder[]> {
    const maxPages = options?.maxPages || 100;
    const pageSize = options?.pageSize || 100;
    const allHolders: TokenHolder[] = [];
    let offset = 0;

    while (offset / pageSize < maxPages) {
      const holders = await this.withRetry(async () => {
        const response = await fetch(
          `https://api.shyft.to/sol/v1/token/get_owners?network=mainnet-beta&token_address=${mintAddress}&limit=${pageSize}&offset=${offset}`,
          {
            headers: { 'x-api-key': this.apiKey },
          }
        );

        if (!response.ok) {
          throw new Error(`Shyft API error: ${response.status}`);
        }

        const data = (await response.json()) as ShyftApiResponse<HolderApiResponse[]>;
        return data.result || [];
      }, `getHolders(${mintAddress}, offset=${offset})`);

      if (!holders || holders.length === 0) {
        break;
      }

      for (const holder of holders) {
        allHolders.push({
          address: holder.owner,
          balance: holder.balance?.toString() || '0',
        });
      }

      logger.debug(`Fetched ${holders.length} holders`, {
        mint: mintAddress,
        offset,
        totalSoFar: allHolders.length,
      });

      if (holders.length < pageSize) {
        break;
      }

      offset += pageSize;
      await this.sleep(100); // Rate limit compliance
    }

    return allHolders;
  }

  /**
   * Get holders count (quick check without fetching all)
   */
  async getHoldersCount(mintAddress: string): Promise<number> {
    return this.withRetry(async () => {
      const response = await fetch(
        `https://api.shyft.to/sol/v1/token/holders_count?network=mainnet-beta&token_address=${mintAddress}`,
        {
          headers: { 'x-api-key': this.apiKey },
        }
      );

      if (!response.ok) {
        throw new Error(`Shyft API error: ${response.status}`);
      }

      const data = (await response.json()) as ShyftApiResponse<{ count: number }>;
      return data.result?.count || 0;
    }, `getHoldersCount(${mintAddress})`);
  }

  /**
   * Get liquidity pools for a token using Shyft DeFi API
   */
  async getPoolsByToken(mintAddress: string, limit = 100): Promise<PoolInfo[]> {
    return this.withRetry(async () => {
      const response = await fetch(
        `https://defi.shyft.to/v0/pools/get_by_token?token=${mintAddress}&limit=${limit}`,
        {
          headers: { 'x-api-key': this.apiKey },
        }
      );

      if (!response.ok) {
        throw new Error(`Shyft DeFi API error: ${response.status}`);
      }

      const data = (await response.json()) as ShyftDefiResponse;

      if (!data.pools || !Array.isArray(data.pools)) {
        return [];
      }

      return data.pools.map((pool) => ({
        poolAddress: pool.address || pool.pool_address || '',
        dex: pool.dex || pool.source || 'unknown',
        baseMint: pool.token_a?.address || pool.base_mint || '',
        quoteMint: pool.token_b?.address || pool.quote_mint || '',
        baseReserve: pool.token_a?.amount?.toString() || pool.base_reserve || '0',
        quoteReserve: pool.token_b?.amount?.toString() || pool.quote_reserve || '0',
        liquidityUsd: pool.liquidity_usd || pool.tvl || 0,
      }));
    }, `getPoolsByToken(${mintAddress})`);
  }

  /**
   * Get single pool info by address
   */
  async getPoolInfo(poolAddress: string): Promise<PoolInfo | null> {
    return this.withRetry(async () => {
      const response = await fetch(
        `https://defi.shyft.to/v0/pools/get_by_address?address=${poolAddress}`,
        {
          headers: { 'x-api-key': this.apiKey },
        }
      );

      if (!response.ok) {
        if (response.status === 404) {
          return null;
        }
        throw new Error(`Shyft DeFi API error: ${response.status}`);
      }

      const data = (await response.json()) as ShyftDefiResponse;
      const pool = data.pool;

      if (!pool) {
        return null;
      }

      return {
        poolAddress: pool.address || pool.pool_address || '',
        dex: pool.dex || pool.source || 'unknown',
        baseMint: pool.token_a?.address || '',
        quoteMint: pool.token_b?.address || '',
        baseReserve: pool.token_a?.amount?.toString() || '0',
        quoteReserve: pool.token_b?.amount?.toString() || '0',
        liquidityUsd: pool.liquidity_usd || pool.tvl || 0,
      };
    }, `getPoolInfo(${poolAddress})`);
  }

  /**
   * Get transaction history for a token (for backfilling)
   */
  async getTransactionHistory(
    mintAddress: string,
    options?: { limit?: number; beforeSignature?: string }
  ): Promise<unknown[]> {
    return this.withRetry(async () => {
      let url = `https://api.shyft.to/sol/v1/transaction/history?network=mainnet-beta&token_address=${mintAddress}`;

      if (options?.limit) {
        url += `&limit=${options.limit}`;
      }
      if (options?.beforeSignature) {
        url += `&before_signature=${options.beforeSignature}`;
      }

      const response = await fetch(url, {
        headers: { 'x-api-key': this.apiKey },
      });

      if (!response.ok) {
        throw new Error(`Shyft API error: ${response.status}`);
      }

      const data = (await response.json()) as ShyftApiResponse<unknown[]>;
      return data.result || [];
    }, `getTransactionHistory(${mintAddress})`);
  }

  /**
   * Check if the client is properly configured
   */
  isConfigured(): boolean {
    return !!this.apiKey;
  }
}

// Export singleton instance
export const shyftClient = new ShyftClient();

export default ShyftClient;
