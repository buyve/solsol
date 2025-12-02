import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { cache } from '../../config/redis.js';

// Common token addresses
const TOKENS = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
};

// Cache TTLs
const CACHE_TTL = {
  SOL_USD: 30,      // 30 seconds for SOL price
  TOKEN_PRICE: 60,  // 60 seconds for token prices
  POOL_INFO: 300,   // 5 minutes for pool info
};

// Normalized pool info for price calculation
interface NormalizedPool {
  pubkey: string;
  dex: string;
  token0Mint: string;
  token1Mint: string;
  reserve0: number;
  reserve1: number;
  decimals0: number;
  decimals1: number;
}

// Shyft API response types
interface ShyftPoolResponse {
  success: boolean;
  message: string;
  result: {
    page: number;
    limit: number;
    dexes: Record<string, {
      pools: RawPool[];
      programId: string;
    }>;
  };
}

// Raw pool structure varies by DEX - we'll normalize it
interface RawPool {
  pubkey: string;
  // Raydium CPMM
  token0Mint?: string;
  token1Mint?: string;
  mint0Decimals?: number;
  mint1Decimals?: number;
  lpSupply?: number;
  // Raydium CLMM has different field names
  tokenMint0?: string;
  tokenMint1?: string;
  mintDecimals0?: number;
  mintDecimals1?: number;
  // Meteora DLMM
  tokenXMint?: string;
  tokenYMint?: string;
  reserveX?: string;
  reserveY?: string;
  // Orca Whirlpool
  tokenMintA?: string;
  tokenMintB?: string;
  tokenVaultA?: string;
  tokenVaultB?: string;
  // Generic
  sqrtPriceX64?: string | number;
  tickCurrent?: number;
  liquidity?: string | number;
}

export interface PriceResult {
  priceSol: number;
  priceUsd: number;
  solUsdRate: number;
  timestamp: Date;
  source: 'shyft-pool' | 'cache';
}

export class ShyftPriceCalculator {
  private baseUrl = 'https://defi.shyft.to';
  private apiKey: string;

  constructor() {
    this.apiKey = config.shyft.apiKey;
  }

  /**
   * Get SOL/USD rate from on-chain pool data
   */
  async getSolUsdRate(): Promise<number> {
    const cacheKey = 'shyft:rate:sol:usd';
    const cached = await cache.get<string>(cacheKey);

    if (cached) {
      return parseFloat(cached);
    }

    try {
      // Get SOL/USDC pools
      const pools = await this.getPoolsByPair(TOKENS.SOL, TOKENS.USDC);

      if (pools.length === 0) {
        // Fallback to SOL/USDT
        const usdtPools = await this.getPoolsByPair(TOKENS.SOL, TOKENS.USDT);
        if (usdtPools.length === 0) {
          throw new Error('No SOL/stable pools found');
        }
        pools.push(...usdtPools);
      }

      // Find a pool with valid price (non-zero reserves)
      let price = 0;
      for (const pool of pools) {
        const calculatedPrice = this.calculatePriceFromPool(pool, TOKENS.SOL);
        if (calculatedPrice > 0) {
          price = calculatedPrice;
          logger.debug('Found valid SOL/USD pool', {
            dex: pool.dex,
            pubkey: pool.pubkey.substring(0, 10) + '...',
            price: calculatedPrice,
          });
          break;
        }
      }

      if (price === 0) {
        throw new Error(`No valid SOL/USD price found in ${pools.length} pools`);
      }

      // Cache the result
      await cache.set(cacheKey, price.toString(), CACHE_TTL.SOL_USD);

      logger.debug('SOL/USD rate from Shyft pool', { rate: price });
      return price;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to get SOL/USD rate from Shyft', {
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  /**
   * Get token price in SOL from pool data
   */
  async getTokenPriceInSol(tokenMint: string): Promise<number | null> {
    const cacheKey = `shyft:price:sol:${tokenMint}`;
    const cached = await cache.get<string>(cacheKey);

    if (cached) {
      return parseFloat(cached);
    }

    try {
      // Get token/SOL pools
      const pools = await this.getPoolsByPair(tokenMint, TOKENS.SOL);

      if (pools.length === 0) {
        return null;
      }

      // Calculate price from the pool with highest liquidity
      const priceInSol = this.calculatePriceFromPool(pools[0], tokenMint);

      // Cache the result
      await cache.set(cacheKey, priceInSol.toString(), CACHE_TTL.TOKEN_PRICE);

      return priceInSol;
    } catch (error) {
      logger.warn('Failed to get token price from Shyft pool', { tokenMint, error });
      return null;
    }
  }

  /**
   * Get full token price (SOL and USD)
   */
  async getTokenPrice(tokenMint: string): Promise<PriceResult | null> {
    const cacheKey = `shyft:price:full:${tokenMint}`;
    const cached = await cache.get<PriceResult>(cacheKey);

    if (cached) {
      return { ...cached, source: 'cache' };
    }

    const [priceInSol, solUsdRate] = await Promise.all([
      this.getTokenPriceInSol(tokenMint),
      this.getSolUsdRate(),
    ]);

    if (priceInSol === null) {
      return null;
    }

    const result: PriceResult = {
      priceSol: priceInSol,
      priceUsd: priceInSol * solUsdRate,
      solUsdRate,
      timestamp: new Date(),
      source: 'shyft-pool',
    };

    await cache.set(cacheKey, result, CACHE_TTL.TOKEN_PRICE);
    return result;
  }

  /**
   * Get pools by token pair from Shyft DeFi API
   */
  private async getPoolsByPair(tokenA: string, tokenB: string): Promise<NormalizedPool[]> {
    const cacheKey = `shyft:pools:${tokenA}:${tokenB}`;
    const cached = await cache.get<NormalizedPool[]>(cacheKey);

    if (cached) {
      return cached;
    }

    const url = `${this.baseUrl}/v0/pools/get_by_pair?tokenA=${tokenA}&tokenB=${tokenB}&limit=10`;

    const response = await fetch(url, {
      headers: {
        'x-api-key': this.apiKey,
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Shyft DeFi API error: ${response.status}`);
    }

    const data = (await response.json()) as ShyftPoolResponse;

    if (!data.success || !data.result?.dexes) {
      return [];
    }

    // Normalize pools from all DEXes
    const normalizedPools: NormalizedPool[] = [];

    for (const [dexName, dexData] of Object.entries(data.result.dexes)) {
      if (!dexData.pools || dexData.pools.length === 0) continue;

      logger.debug(`Processing ${dexName} pools`, {
        count: dexData.pools.length,
        sampleFields: dexData.pools[0] ? Object.keys(dexData.pools[0]).slice(0, 15) : [],
      });

      for (const pool of dexData.pools) {
        const normalized = this.normalizePool(pool, dexName, tokenA, tokenB);
        if (normalized) {
          normalizedPools.push(normalized);
          logger.debug('Pool normalized', {
            dex: dexName,
            pubkey: pool.pubkey?.substring(0, 10) + '...',
            reserve0: normalized.reserve0,
            reserve1: normalized.reserve1,
            hasSqrtPrice: !!pool.sqrtPriceX64,
          });
        } else {
          logger.debug('Pool normalization failed', {
            dex: dexName,
            pubkey: pool.pubkey?.substring(0, 10) + '...',
            hasToken0Mint: !!pool.token0Mint,
            hasTokenMint0: !!pool.tokenMint0,
            hasTokenXMint: !!pool.tokenXMint,
            hasTokenMintA: !!pool.tokenMintA,
          });
        }
      }
    }

    await cache.set(cacheKey, normalizedPools, CACHE_TTL.POOL_INFO);
    return normalizedPools;
  }

  /**
   * Normalize pool data from different DEX formats
   */
  private normalizePool(pool: RawPool, dexName: string, tokenA: string, tokenB: string): NormalizedPool | null {
    let token0Mint: string | undefined;
    let token1Mint: string | undefined;
    let decimals0 = 9; // Default SOL decimals
    let decimals1 = 6; // Default USDC decimals

    // Handle different DEX formats
    if (pool.token0Mint && pool.token1Mint) {
      // Raydium CPMM format
      token0Mint = pool.token0Mint;
      token1Mint = pool.token1Mint;
      decimals0 = pool.mint0Decimals ?? 9;
      decimals1 = pool.mint1Decimals ?? 6;
    } else if (pool.tokenMint0 && pool.tokenMint1) {
      // Raydium CLMM format (different field names!)
      token0Mint = pool.tokenMint0;
      token1Mint = pool.tokenMint1;
      decimals0 = pool.mintDecimals0 ?? 9;
      decimals1 = pool.mintDecimals1 ?? 6;
    } else if (pool.tokenXMint && pool.tokenYMint) {
      // Meteora DLMM format
      token0Mint = pool.tokenXMint;
      token1Mint = pool.tokenYMint;
    } else if (pool.tokenMintA && pool.tokenMintB) {
      // Orca Whirlpool format
      token0Mint = pool.tokenMintA;
      token1Mint = pool.tokenMintB;
    }

    if (!token0Mint || !token1Mint) {
      return null;
    }

    // Calculate price from sqrtPriceX64 if available
    let reserve0 = 0;
    let reserve1 = 0;

    if (pool.sqrtPriceX64) {
      try {
        // For CLMM pools, we can derive price from sqrtPriceX64
        // price = (sqrtPriceX64 / 2^64)^2 * 10^(decimals0 - decimals1)
        const sqrtPriceValue = typeof pool.sqrtPriceX64 === 'string'
          ? BigInt(pool.sqrtPriceX64)
          : BigInt(Math.floor(Number(pool.sqrtPriceX64)));

        const TWO_POW_64 = BigInt('18446744073709551616'); // 2^64
        const sqrtPriceNum = Number(sqrtPriceValue) / Number(TWO_POW_64);
        const rawPrice = sqrtPriceNum * sqrtPriceNum;

        // Adjust for decimals
        const decimalAdjustment = Math.pow(10, decimals0 - decimals1);
        const price = rawPrice * decimalAdjustment;

        // Set synthetic reserves based on price
        // This allows us to use the same price calculation logic
        reserve0 = 1 * Math.pow(10, decimals0);
        reserve1 = price * Math.pow(10, decimals1);

        logger.debug('Normalized pool from sqrtPriceX64', {
          dex: dexName,
          sqrtPriceX64: pool.sqrtPriceX64.toString().substring(0, 20),
          calculatedPrice: price,
        });
      } catch (error) {
        logger.warn('Failed to parse sqrtPriceX64', {
          dex: dexName,
          sqrtPriceX64: String(pool.sqrtPriceX64).substring(0, 20),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      pubkey: pool.pubkey,
      dex: dexName,
      token0Mint,
      token1Mint,
      reserve0,
      reserve1,
      decimals0,
      decimals1,
    };
  }

  /**
   * Calculate token price from pool
   */
  private calculatePriceFromPool(pool: NormalizedPool, targetToken: string): number {
    const isToken0 = pool.token0Mint === targetToken;

    if (pool.reserve0 === 0 || pool.reserve1 === 0) {
      // Try to use sqrtPriceX64 based calculation
      if (pool.reserve0 > 0 && pool.reserve1 > 0) {
        const targetAmount = isToken0
          ? pool.reserve0 / Math.pow(10, pool.decimals0)
          : pool.reserve1 / Math.pow(10, pool.decimals1);
        const quoteAmount = isToken0
          ? pool.reserve1 / Math.pow(10, pool.decimals1)
          : pool.reserve0 / Math.pow(10, pool.decimals0);

        if (targetAmount === 0) return 0;
        return quoteAmount / targetAmount;
      }
      return 0;
    }

    const targetAmount = isToken0
      ? pool.reserve0 / Math.pow(10, pool.decimals0)
      : pool.reserve1 / Math.pow(10, pool.decimals1);
    const quoteAmount = isToken0
      ? pool.reserve1 / Math.pow(10, pool.decimals1)
      : pool.reserve0 / Math.pow(10, pool.decimals0);

    if (targetAmount === 0) {
      return 0;
    }

    // Price = quote / target
    return quoteAmount / targetAmount;
  }

  /**
   * Get all pools for a token
   */
  async getPoolsForToken(tokenMint: string): Promise<NormalizedPool[]> {
    const cacheKey = `shyft:pools:token:${tokenMint}`;
    const cached = await cache.get<NormalizedPool[]>(cacheKey);

    if (cached) {
      return cached;
    }

    const url = `${this.baseUrl}/v0/pools/get_by_token?token=${tokenMint}&limit=10`;

    const response = await fetch(url, {
      headers: {
        'x-api-key': this.apiKey,
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Shyft DeFi API error: ${response.status}`);
    }

    const data = (await response.json()) as ShyftPoolResponse;

    if (!data.success || !data.result?.dexes) {
      return [];
    }

    // Normalize pools from all DEXes
    const normalizedPools: NormalizedPool[] = [];

    for (const [dexName, dexData] of Object.entries(data.result.dexes)) {
      if (!dexData.pools || dexData.pools.length === 0) continue;

      for (const pool of dexData.pools) {
        const normalized = this.normalizePool(pool, dexName, tokenMint, '');
        if (normalized) {
          normalizedPools.push(normalized);
        }
      }
    }

    await cache.set(cacheKey, normalizedPools, CACHE_TTL.POOL_INFO);
    return normalizedPools;
  }
}

// Export singleton
export const shyftPriceCalculator = new ShyftPriceCalculator();
