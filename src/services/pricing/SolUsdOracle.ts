import { Connection, PublicKey } from '@solana/web3.js';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { cache } from '../../config/redis.js';

// Pyth Network Price Feed Accounts (Mainnet)
export const PYTH_PRICE_FEEDS = {
  SOL_USD: 'H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4BER6d',
  // Additional feeds for reference
  BTC_USD: 'GVXRSBjFk6e6J3NbVPXohDJetcTjaeeuykUpbQF8UoMU',
  ETH_USD: 'JBu1AL4obBcCMqKBBxhpWCNUt136ijcuMZLFvTP7iWdB',
};

// Pyth price data layout offsets
const PYTH_PRICE_DATA_OFFSETS = {
  magic: 0,          // 4 bytes
  version: 4,        // 4 bytes
  priceType: 8,      // 4 bytes
  exponent: 20,      // 4 bytes (i32)
  price: 208,        // 8 bytes (i64)
  confidence: 216,   // 8 bytes (u64)
  status: 224,       // 4 bytes
  publishSlot: 240,  // 8 bytes (u64)
};

export interface OraclePrice {
  price: number;
  confidence: number;
  exponent: number;
  publishSlot: number;
  source: 'pyth' | 'jupiter' | 'cache';
  timestamp: Date;
}

export interface SolUsdOracleOptions {
  rpcEndpoint?: string;
  cacheTtl?: number;
}

export class SolUsdOracle {
  private connection: Connection;
  private cacheTtl: number;
  private static readonly CACHE_KEY = 'oracle:sol:usd';
  private static readonly FALLBACK_CACHE_KEY = 'oracle:sol:usd:fallback';

  constructor(options?: SolUsdOracleOptions) {
    const endpoint = options?.rpcEndpoint || config.solana.rpcUrl;
    this.connection = new Connection(endpoint, 'confirmed');
    this.cacheTtl = options?.cacheTtl || 10; // 10 seconds default
  }

  /**
   * Get SOL/USD price from Pyth Network
   */
  async getSolUsdPrice(): Promise<OraclePrice | null> {
    // Check cache first
    const cached = await cache.get<OraclePrice>(SolUsdOracle.CACHE_KEY);
    if (cached) {
      return { ...cached, source: 'cache' };
    }

    try {
      const price = await this.fetchPythPrice(PYTH_PRICE_FEEDS.SOL_USD);

      if (price) {
        // Cache the result
        await cache.set(SolUsdOracle.CACHE_KEY, price, this.cacheTtl);
        // Also store as fallback with longer TTL
        await cache.set(SolUsdOracle.FALLBACK_CACHE_KEY, price, 300); // 5 minutes
        return price;
      }

      // Try fallback cache if Pyth fails
      const fallback = await cache.get<OraclePrice>(SolUsdOracle.FALLBACK_CACHE_KEY);
      if (fallback) {
        logger.warn('Using fallback SOL/USD price', {
          price: fallback.price,
          age: Date.now() - new Date(fallback.timestamp).getTime(),
        });
        return { ...fallback, source: 'cache' };
      }

      return null;
    } catch (error) {
      logger.error('Failed to fetch SOL/USD from Pyth', {
        error: (error as Error).message,
      });

      // Return fallback if available
      const fallback = await cache.get<OraclePrice>(SolUsdOracle.FALLBACK_CACHE_KEY);
      return fallback ? { ...fallback, source: 'cache' } : null;
    }
  }

  /**
   * Fetch price from Pyth price feed account
   */
  private async fetchPythPrice(feedAddress: string): Promise<OraclePrice | null> {
    try {
      const feedPubkey = new PublicKey(feedAddress);
      const accountInfo = await this.connection.getAccountInfo(feedPubkey);

      if (!accountInfo?.data) {
        logger.warn('Pyth price feed account not found', { feedAddress });
        return null;
      }

      const parsedPrice = this.parsePythPriceData(accountInfo.data);
      return parsedPrice;
    } catch (error) {
      logger.error('Failed to fetch Pyth price', {
        feedAddress,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Parse Pyth price account data
   */
  private parsePythPriceData(data: Buffer): OraclePrice | null {
    try {
      // Verify magic number (0xa1b2c3d4)
      const magic = data.readUInt32LE(PYTH_PRICE_DATA_OFFSETS.magic);
      if (magic !== 0xa1b2c3d4) {
        logger.warn('Invalid Pyth magic number', { magic: magic.toString(16) });
        return null;
      }

      // Read exponent (i32)
      const exponent = data.readInt32LE(PYTH_PRICE_DATA_OFFSETS.exponent);

      // Read price (i64) - handle as BigInt then convert
      const priceRaw = data.readBigInt64LE(PYTH_PRICE_DATA_OFFSETS.price);

      // Read confidence (u64)
      const confidenceRaw = data.readBigUInt64LE(PYTH_PRICE_DATA_OFFSETS.confidence);

      // Read publish slot (u64)
      const publishSlot = Number(data.readBigUInt64LE(PYTH_PRICE_DATA_OFFSETS.publishSlot));

      // Convert to actual price
      const price = Number(priceRaw) * Math.pow(10, exponent);
      const confidence = Number(confidenceRaw) * Math.pow(10, exponent);

      if (price <= 0) {
        logger.warn('Invalid Pyth price', { priceRaw: priceRaw.toString() });
        return null;
      }

      return {
        price,
        confidence,
        exponent,
        publishSlot,
        source: 'pyth',
        timestamp: new Date(),
      };
    } catch (error) {
      logger.error('Failed to parse Pyth price data', {
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Get SOL/USD price with Jupiter fallback
   */
  async getSolUsdPriceWithFallback(jupiterPrice?: number): Promise<number> {
    const pythPrice = await this.getSolUsdPrice();

    if (pythPrice && pythPrice.price > 0) {
      return pythPrice.price;
    }

    // Use Jupiter price as fallback
    if (jupiterPrice && jupiterPrice > 0) {
      logger.info('Using Jupiter SOL/USD as fallback', { price: jupiterPrice });
      return jupiterPrice;
    }

    // Last resort: check extended fallback cache
    const fallback = await cache.get<OraclePrice>(SolUsdOracle.FALLBACK_CACHE_KEY);
    if (fallback && fallback.price > 0) {
      return fallback.price;
    }

    throw new Error('Unable to fetch SOL/USD price from any source');
  }

  /**
   * Subscribe to price updates (polling-based)
   */
  startPolling(
    callback: (price: OraclePrice) => void,
    intervalMs: number = 5000
  ): () => void {
    let isRunning = true;

    const poll = async () => {
      while (isRunning) {
        try {
          const price = await this.fetchPythPrice(PYTH_PRICE_FEEDS.SOL_USD);
          if (price) {
            callback(price);
          }
        } catch (error) {
          logger.error('Polling error', { error: (error as Error).message });
        }

        await this.sleep(intervalMs);
      }
    };

    poll();

    // Return stop function
    return () => {
      isRunning = false;
    };
  }

  /**
   * Get price confidence as percentage
   */
  static getConfidencePercentage(price: OraclePrice): number {
    if (price.price === 0) return 0;
    return (price.confidence / price.price) * 100;
  }

  /**
   * Check if price is stale (older than threshold)
   */
  static isPriceStale(price: OraclePrice, thresholdMs: number = 60000): boolean {
    const age = Date.now() - new Date(price.timestamp).getTime();
    return age > thresholdMs;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Export singleton instance
export const solUsdOracle = new SolUsdOracle();

export default SolUsdOracle;
