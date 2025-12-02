import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { cache } from '../../config/redis.js';
import { jupiterLimiter } from '../queue/RateLimiter.js';

// SOL mint address
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Cache TTLs - increased to reduce API calls
const CACHE_TTL = {
  PRICE: 60,      // 60 seconds
  SOL_USD: 60,    // 60 seconds (SOL price doesn't change frequently)
};

export interface TokenPrice {
  id: string;
  price: number;
  type?: string;
  extraInfo?: {
    quotedPrice?: {
      buyPrice?: string;
      sellPrice?: string;
    };
    confidenceLevel?: string;
    depth?: {
      buyPriceImpactRatio?: Record<string, number>;
      sellPriceImpactRatio?: Record<string, number>;
    };
  };
}

export interface PriceResult {
  priceSol: number;
  priceUsd: number;
  solUsdRate: number;
  timestamp: Date;
  source: 'jupiter' | 'cache';
}

export interface JupiterClientOptions {
  apiUrl?: string;
  maxRetries?: number;
  retryDelayMs?: number;
  rateLimitPerMinute?: number;
}

// API Response type for Jupiter v3
interface JupiterV3TokenData {
  usdPrice: number;
  blockId?: number;
  decimals?: number;
  priceChange24h?: number;
}

type JupiterPriceResponse = Record<string, JupiterV3TokenData | null>;

export class JupiterPriceClient {
  private apiUrl: string;
  private maxRetries: number;
  private retryDelayMs: number;
  private rateLimitPerMinute: number;
  private requestCount: number = 0;
  private lastRequestTime: number = 0;

  constructor(options?: JupiterClientOptions) {
    this.apiUrl = options?.apiUrl || config.jupiter.apiUrl;
    this.maxRetries = options?.maxRetries || 3;
    this.retryDelayMs = options?.retryDelayMs || 1000;
    this.rateLimitPerMinute = options?.rateLimitPerMinute || 60;
  }

  /**
   * Execute with retry logic
   */
  private async withRetry<T>(
    operation: () => Promise<T>,
    operationName: string
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        await this.checkRateLimit();
        return await operation();
      } catch (error) {
        lastError = error as Error;
        const delay = this.retryDelayMs * Math.pow(2, attempt - 1);

        logger.warn(`${operationName} failed (attempt ${attempt}/${this.maxRetries})`, {
          error: lastError.message,
        });

        if (attempt < this.maxRetries) {
          await this.sleep(delay);
        }
      }
    }

    throw lastError;
  }

  /**
   * Check and enforce rate limit using Redis-based rate limiter
   */
  private async checkRateLimit(): Promise<void> {
    try {
      const result = await jupiterLimiter.checkLimit();

      if (!result.allowed) {
        logger.debug('Jupiter rate limit reached, waiting...', {
          resetIn: result.resetIn,
          remaining: result.remaining,
        });
        await this.sleep(result.resetIn + 100);
      }

      // Also track local counter for quick checks
      const now = Date.now();
      const timeSinceFirst = now - this.lastRequestTime;

      if (timeSinceFirst > 60000) {
        this.requestCount = 0;
        this.lastRequestTime = now;
      }
      this.requestCount++;
    } catch (error) {
      // If Redis is unavailable, fall back to local rate limiting
      const now = Date.now();
      const timeSinceFirst = now - this.lastRequestTime;

      if (timeSinceFirst > 60000) {
        this.requestCount = 0;
        this.lastRequestTime = now;
      }

      if (this.requestCount >= this.rateLimitPerMinute) {
        const waitTime = 60000 - timeSinceFirst;
        if (waitTime > 0) {
          logger.debug(`Local rate limit reached, waiting ${waitTime}ms`);
          await this.sleep(waitTime);
          this.requestCount = 0;
          this.lastRequestTime = Date.now();
        }
      }

      this.requestCount++;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get SOL/USD rate
   */
  async getSolUsdRate(): Promise<number> {
    // Try cache first
    const cacheKey = 'rate:sol:usd';
    const cached = await cache.get<string>(cacheKey);

    if (cached) {
      return parseFloat(cached);
    }

    const rate = await this.withRetry(async () => {
      const response = await fetch(`${this.apiUrl}?ids=${SOL_MINT}`);

      if (!response.ok) {
        throw new Error(`Jupiter API error: ${response.status}`);
      }

      const data = (await response.json()) as JupiterPriceResponse;
      const solData = data[SOL_MINT];

      if (!solData?.usdPrice) {
        throw new Error('SOL price not found in response');
      }

      return solData.usdPrice;
    }, 'getSolUsdRate');

    // Cache the result
    await cache.set(cacheKey, rate.toString(), CACHE_TTL.SOL_USD);

    logger.debug('SOL/USD rate fetched', { rate });
    return rate;
  }

  /**
   * Get price for a single token
   */
  async getPrice(mintAddress: string): Promise<TokenPrice | null> {
    return this.withRetry(async () => {
      const response = await fetch(`${this.apiUrl}?ids=${mintAddress}`);

      if (!response.ok) {
        throw new Error(`Jupiter API error: ${response.status}`);
      }

      const data = (await response.json()) as JupiterPriceResponse;
      const tokenData = data[mintAddress];

      if (!tokenData?.usdPrice) {
        return null;
      }

      return {
        id: mintAddress,
        price: tokenData.usdPrice,
      };
    }, `getPrice(${mintAddress})`);
  }

  /**
   * Get prices for multiple tokens (batch query)
   * Jupiter v3 supports up to 100 tokens per request
   */
  async getBatchPrices(mintAddresses: string[]): Promise<Map<string, TokenPrice>> {
    const results = new Map<string, TokenPrice>();

    // Process in batches of 50 (recommended)
    const batchSize = 50;
    const batches: string[][] = [];

    for (let i = 0; i < mintAddresses.length; i += batchSize) {
      batches.push(mintAddresses.slice(i, i + batchSize));
    }

    for (const batch of batches) {
      const batchResults = await this.withRetry(async () => {
        const ids = batch.join(',');
        const response = await fetch(`${this.apiUrl}?ids=${ids}`);

        if (!response.ok) {
          throw new Error(`Jupiter API error: ${response.status}`);
        }

        const data = (await response.json()) as JupiterPriceResponse;
        const prices = new Map<string, TokenPrice>();

        for (const mint of batch) {
          const tokenData = data[mint];
          if (tokenData?.usdPrice) {
            prices.set(mint, {
              id: mint,
              price: tokenData.usdPrice,
            });
          }
        }

        return prices;
      }, `getBatchPrices(${batch.length} tokens)`);

      // Merge results
      for (const [mint, price] of batchResults) {
        results.set(mint, price);
      }
    }

    logger.debug('Batch prices fetched', {
      requested: mintAddresses.length,
      found: results.size,
    });

    return results;
  }

  /**
   * Get token price in both SOL and USD
   */
  async getTokenPrice(mintAddress: string): Promise<PriceResult | null> {
    // Check cache first
    const cacheKey = `price:${mintAddress}`;
    const cached = await cache.get<PriceResult>(cacheKey);

    if (cached) {
      return { ...cached, source: 'cache' };
    }

    // Get SOL/USD rate
    const solUsdRate = await this.getSolUsdRate();

    // Get token price
    const tokenPrice = await this.getPrice(mintAddress);

    if (!tokenPrice) {
      return null;
    }

    // Token price from Jupiter is in USD
    const priceUsd = tokenPrice.price;
    const priceSol = priceUsd / solUsdRate;

    const result: PriceResult = {
      priceSol,
      priceUsd,
      solUsdRate,
      timestamp: new Date(),
      source: 'jupiter',
    };

    // Cache the result
    await cache.set(cacheKey, result, CACHE_TTL.PRICE);

    logger.debug('Token price fetched', {
      mint: mintAddress,
      priceUsd,
      priceSol,
    });

    return result;
  }

  /**
   * Get prices for multiple tokens with SOL conversion
   */
  async getTokenPrices(mintAddresses: string[]): Promise<Map<string, PriceResult>> {
    const results = new Map<string, PriceResult>();

    // Get SOL/USD rate first
    const solUsdRate = await this.getSolUsdRate();

    // Get batch prices
    const batchPrices = await this.getBatchPrices(mintAddresses);

    for (const [mint, tokenPrice] of batchPrices) {
      const priceUsd = tokenPrice.price;
      const priceSol = priceUsd / solUsdRate;

      results.set(mint, {
        priceSol,
        priceUsd,
        solUsdRate,
        timestamp: new Date(),
        source: 'jupiter',
      });
    }

    return results;
  }

  /**
   * Invalidate cached price
   */
  async invalidateCache(mintAddress: string): Promise<void> {
    await cache.del(`price:${mintAddress}`);
  }

  /**
   * Get rate limit status
   */
  getRateLimitStatus(): { remaining: number; resetIn: number } {
    const now = Date.now();
    const timeSinceFirst = now - this.lastRequestTime;
    const resetIn = Math.max(0, 60000 - timeSinceFirst);
    const remaining = Math.max(0, this.rateLimitPerMinute - this.requestCount);

    return { remaining, resetIn };
  }
}

// Export singleton instance
export const jupiterPriceClient = new JupiterPriceClient();

export default JupiterPriceClient;
