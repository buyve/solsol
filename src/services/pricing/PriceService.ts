import { EventEmitter } from 'events';
import { logger } from '../../utils/logger.js';
import { cache } from '../../config/redis.js';
import {
  JupiterPriceClient,
  PriceResult,
  SOL_MINT,
} from '../external/JupiterPriceClient.js';
import {
  OnchainPriceCalculator,
  OnchainPrice,
  KNOWN_MINTS,
} from './OnchainPriceCalculator.js';
import { SolUsdOracle, OraclePrice } from './SolUsdOracle.js';

export type PriceSource = 'jupiter' | 'onchain' | 'oracle' | 'cache';

export interface TokenPriceInfo {
  mintAddress: string;
  priceSol: number;
  priceUsd: number;
  solUsdRate: number;
  source: PriceSource;
  confidence?: number;
  timestamp: Date;
}

export interface PriceServiceOptions {
  enableOnchainFallback?: boolean;
  enableOracleForSol?: boolean;
  cacheTtl?: number;
}

export interface PriceServiceEvents {
  priceUpdate: (price: TokenPriceInfo) => void;
  solUsdUpdate: (price: OraclePrice) => void;
  error: (error: Error) => void;
}

export class PriceService extends EventEmitter {
  private jupiterClient: JupiterPriceClient;
  private onchainCalculator: OnchainPriceCalculator;
  private solUsdOracle: SolUsdOracle;
  private options: Required<PriceServiceOptions>;
  private stopOraclePolling?: () => void;

  private static readonly CACHE_PREFIX = 'price:unified:';
  private static readonly DEFAULT_CACHE_TTL = 30;

  constructor(options?: PriceServiceOptions) {
    super();
    this.jupiterClient = new JupiterPriceClient();
    this.onchainCalculator = new OnchainPriceCalculator();
    this.solUsdOracle = new SolUsdOracle();

    this.options = {
      enableOnchainFallback: options?.enableOnchainFallback ?? true,
      enableOracleForSol: options?.enableOracleForSol ?? true,
      cacheTtl: options?.cacheTtl ?? PriceService.DEFAULT_CACHE_TTL,
    };
  }

  /**
   * Get SOL/USD rate from the best available source
   */
  async getSolUsdRate(): Promise<{ rate: number; source: PriceSource }> {
    if (this.options.enableOracleForSol) {
      try {
        const oraclePrice = await this.solUsdOracle.getSolUsdPrice();
        if (oraclePrice && oraclePrice.price > 0) {
          return { rate: oraclePrice.price, source: 'oracle' };
        }
      } catch (error) {
        logger.warn('Oracle SOL/USD failed, trying Jupiter', {
          error: (error as Error).message,
        });
      }
    }

    // Fallback to Jupiter
    const jupiterRate = await this.jupiterClient.getSolUsdRate();
    return { rate: jupiterRate, source: 'jupiter' };
  }

  /**
   * Get token price with automatic fallback
   */
  async getTokenPrice(mintAddress: string): Promise<TokenPriceInfo | null> {
    // Check cache first
    const cacheKey = `${PriceService.CACHE_PREFIX}${mintAddress}`;
    const cached = await cache.get<TokenPriceInfo>(cacheKey);

    if (cached) {
      return { ...cached, source: 'cache' };
    }

    // Get SOL/USD rate
    const { rate: solUsdRate, source: rateSource } = await this.getSolUsdRate();

    // Try Jupiter first
    try {
      const jupiterPrice = await this.jupiterClient.getPrice(mintAddress);

      if (jupiterPrice && jupiterPrice.price > 0) {
        const priceInfo: TokenPriceInfo = {
          mintAddress,
          priceUsd: jupiterPrice.price,
          priceSol: jupiterPrice.price / solUsdRate,
          solUsdRate,
          source: 'jupiter',
          timestamp: new Date(),
        };

        await cache.set(cacheKey, priceInfo, this.options.cacheTtl);
        this.emit('priceUpdate', priceInfo);
        return priceInfo;
      }
    } catch (error) {
      logger.warn('Jupiter price fetch failed', {
        mintAddress,
        error: (error as Error).message,
      });
    }

    // Try on-chain fallback
    if (this.options.enableOnchainFallback) {
      try {
        const onchainPrice = await this.onchainCalculator.getBestPrice(mintAddress);

        if (onchainPrice) {
          const usdPrice = await this.onchainCalculator.calculateUsdPrice(
            onchainPrice,
            solUsdRate
          );

          if (usdPrice !== null) {
            const priceInfo: TokenPriceInfo = {
              mintAddress,
              priceUsd: usdPrice,
              priceSol: usdPrice / solUsdRate,
              solUsdRate,
              source: 'onchain',
              timestamp: new Date(),
            };

            await cache.set(cacheKey, priceInfo, this.options.cacheTtl);
            this.emit('priceUpdate', priceInfo);
            return priceInfo;
          }
        }
      } catch (error) {
        logger.warn('On-chain price calculation failed', {
          mintAddress,
          error: (error as Error).message,
        });
      }
    }

    logger.warn('Unable to fetch price from any source', { mintAddress });
    return null;
  }

  /**
   * Get prices for multiple tokens
   */
  async getTokenPrices(mintAddresses: string[]): Promise<Map<string, TokenPriceInfo>> {
    const results = new Map<string, TokenPriceInfo>();
    const notCached: string[] = [];

    // Check cache for each token
    for (const mint of mintAddresses) {
      const cacheKey = `${PriceService.CACHE_PREFIX}${mint}`;
      const cached = await cache.get<TokenPriceInfo>(cacheKey);

      if (cached) {
        results.set(mint, { ...cached, source: 'cache' });
      } else {
        notCached.push(mint);
      }
    }

    if (notCached.length === 0) {
      return results;
    }

    // Get SOL/USD rate
    const { rate: solUsdRate } = await this.getSolUsdRate();

    // Batch fetch from Jupiter
    const jupiterPrices = await this.jupiterClient.getBatchPrices(notCached);
    const stillMissing: string[] = [];

    for (const mint of notCached) {
      const jupiterPrice = jupiterPrices.get(mint);

      if (jupiterPrice && jupiterPrice.price > 0) {
        const priceInfo: TokenPriceInfo = {
          mintAddress: mint,
          priceUsd: jupiterPrice.price,
          priceSol: jupiterPrice.price / solUsdRate,
          solUsdRate,
          source: 'jupiter',
          timestamp: new Date(),
        };

        const cacheKey = `${PriceService.CACHE_PREFIX}${mint}`;
        await cache.set(cacheKey, priceInfo, this.options.cacheTtl);
        results.set(mint, priceInfo);
      } else {
        stillMissing.push(mint);
      }
    }

    // Try on-chain for missing prices
    if (this.options.enableOnchainFallback && stillMissing.length > 0) {
      for (const mint of stillMissing) {
        try {
          const onchainPrice = await this.onchainCalculator.getBestPrice(mint);

          if (onchainPrice) {
            const usdPrice = await this.onchainCalculator.calculateUsdPrice(
              onchainPrice,
              solUsdRate
            );

            if (usdPrice !== null) {
              const priceInfo: TokenPriceInfo = {
                mintAddress: mint,
                priceUsd: usdPrice,
                priceSol: usdPrice / solUsdRate,
                solUsdRate,
                source: 'onchain',
                timestamp: new Date(),
              };

              const cacheKey = `${PriceService.CACHE_PREFIX}${mint}`;
              await cache.set(cacheKey, priceInfo, this.options.cacheTtl);
              results.set(mint, priceInfo);
            }
          }
        } catch (error) {
          logger.debug('On-chain fallback failed for token', {
            mint,
            error: (error as Error).message,
          });
        }
      }
    }

    logger.debug('Batch prices fetched', {
      requested: mintAddresses.length,
      found: results.size,
      fromCache: mintAddresses.length - notCached.length,
      fromJupiter: jupiterPrices.size,
      fromOnchain: results.size - (mintAddresses.length - notCached.length) - jupiterPrices.size,
    });

    return results;
  }

  /**
   * Start SOL/USD oracle polling for real-time updates
   */
  startSolUsdPolling(intervalMs: number = 5000): void {
    if (this.stopOraclePolling) {
      return; // Already polling
    }

    this.stopOraclePolling = this.solUsdOracle.startPolling((price) => {
      this.emit('solUsdUpdate', price);
    }, intervalMs);

    logger.info('Started SOL/USD oracle polling', { intervalMs });
  }

  /**
   * Stop SOL/USD oracle polling
   */
  stopSolUsdPolling(): void {
    if (this.stopOraclePolling) {
      this.stopOraclePolling();
      this.stopOraclePolling = undefined;
      logger.info('Stopped SOL/USD oracle polling');
    }
  }

  /**
   * Invalidate cached price
   */
  async invalidatePrice(mintAddress: string): Promise<void> {
    const cacheKey = `${PriceService.CACHE_PREFIX}${mintAddress}`;
    await cache.del(cacheKey);
  }

  /**
   * Get price statistics
   */
  async getPriceStats(): Promise<{
    cacheSize: number;
    jupiterRateLimit: { remaining: number; resetIn: number };
  }> {
    return {
      cacheSize: 0, // Would need Redis scan to count
      jupiterRateLimit: this.jupiterClient.getRateLimitStatus(),
    };
  }

  /**
   * Convert USD amount to SOL
   */
  async usdToSol(usdAmount: number): Promise<number> {
    const { rate } = await this.getSolUsdRate();
    return usdAmount / rate;
  }

  /**
   * Convert SOL amount to USD
   */
  async solToUsd(solAmount: number): Promise<number> {
    const { rate } = await this.getSolUsdRate();
    return solAmount * rate;
  }

  /**
   * Check if a price is considered stale
   */
  static isPriceStale(price: TokenPriceInfo, maxAgeMs: number = 60000): boolean {
    const age = Date.now() - new Date(price.timestamp).getTime();
    return age > maxAgeMs;
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    this.stopSolUsdPolling();
    this.removeAllListeners();
  }
}

// Export singleton instance
export const priceService = new PriceService();

export default PriceService;
