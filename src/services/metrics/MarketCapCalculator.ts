import { Connection, PublicKey } from '@solana/web3.js';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { cache } from '../../config/redis.js';
import { priceService, TokenPriceInfo } from '../pricing/PriceService.js';
import { shyftClient, TokenInfo } from '../external/ShyftClient.js';

// Standard Solana token decimals
const DEFAULT_DECIMALS = 9;

export interface TokenSupplyInfo {
  mintAddress: string;
  totalSupply: bigint;
  circulatingSupply: bigint;
  decimals: number;
  totalSupplyFormatted: number;
  circulatingSupplyFormatted: number;
}

export interface MarketCapInfo {
  mintAddress: string;
  price: TokenPriceInfo;
  supply: TokenSupplyInfo;
  marketCap: number;        // Circulating supply * price
  fullyDilutedValue: number; // Total supply * price
  marketCapSol: number;
  fdvSol: number;
  circulatingRatio: number; // circulatingSupply / totalSupply
  timestamp: Date;
}

export interface MarketCapCalculatorOptions {
  rpcEndpoint?: string;
  cacheTtl?: number;
}

export class MarketCapCalculator {
  private connection: Connection;
  private cacheTtl: number;
  private static readonly CACHE_PREFIX = 'mcap:';
  private static readonly SUPPLY_CACHE_PREFIX = 'supply:';

  constructor(options?: MarketCapCalculatorOptions) {
    const endpoint = options?.rpcEndpoint || config.solana.rpcUrl;
    this.connection = new Connection(endpoint, 'confirmed');
    this.cacheTtl = options?.cacheTtl || 60; // 1 minute default
  }

  /**
   * Get token supply information
   */
  async getTokenSupply(mintAddress: string): Promise<TokenSupplyInfo | null> {
    // Check cache first
    const cacheKey = `${MarketCapCalculator.SUPPLY_CACHE_PREFIX}${mintAddress}`;
    const cached = await cache.get<TokenSupplyInfo>(cacheKey);

    if (cached) {
      return cached;
    }

    try {
      const mintPubkey = new PublicKey(mintAddress);

      // Get token supply from RPC
      const supplyResponse = await this.connection.getTokenSupply(mintPubkey);

      if (!supplyResponse?.value) {
        logger.warn('Token supply not found', { mintAddress });
        return null;
      }

      const { amount, decimals } = supplyResponse.value;
      const totalSupply = BigInt(amount);

      // For now, assume circulating = total (would need more data for burned/locked tokens)
      // Could be enhanced by checking burn addresses, locked accounts, etc.
      const circulatingSupply = await this.calculateCirculatingSupply(
        mintAddress,
        totalSupply
      );

      const divisor = Math.pow(10, decimals);
      const supplyInfo: TokenSupplyInfo = {
        mintAddress,
        totalSupply,
        circulatingSupply,
        decimals,
        totalSupplyFormatted: Number(totalSupply) / divisor,
        circulatingSupplyFormatted: Number(circulatingSupply) / divisor,
      };

      // Cache the result
      await cache.set(cacheKey, {
        ...supplyInfo,
        totalSupply: totalSupply.toString(),
        circulatingSupply: circulatingSupply.toString(),
      }, this.cacheTtl);

      return supplyInfo;
    } catch (error) {
      logger.error('Failed to get token supply', {
        mintAddress,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Calculate circulating supply (excluding burned/locked tokens)
   */
  private async calculateCirculatingSupply(
    mintAddress: string,
    totalSupply: bigint
  ): Promise<bigint> {
    // Known burn addresses
    const burnAddresses = [
      '1nc1nerator11111111111111111111111111111111',
      '11111111111111111111111111111111',
    ];

    let burnedAmount = BigInt(0);

    try {
      for (const burnAddr of burnAddresses) {
        try {
          const burnPubkey = new PublicKey(burnAddr);
          const mintPubkey = new PublicKey(mintAddress);

          const tokenAccounts = await this.connection.getTokenAccountsByOwner(
            burnPubkey,
            { mint: mintPubkey }
          );

          for (const account of tokenAccounts.value) {
            const amount = account.account.data.readBigUInt64LE(64);
            burnedAmount += amount;
          }
        } catch {
          // Burn address might not have any tokens
          continue;
        }
      }
    } catch (error) {
      logger.debug('Error checking burn addresses', {
        error: (error as Error).message,
      });
    }

    return totalSupply - burnedAmount;
  }

  /**
   * Calculate market cap and FDV for a token
   */
  async getMarketCap(mintAddress: string): Promise<MarketCapInfo | null> {
    // Check cache first
    const cacheKey = `${MarketCapCalculator.CACHE_PREFIX}${mintAddress}`;
    const cached = await cache.get<MarketCapInfo>(cacheKey);

    if (cached) {
      return cached;
    }

    try {
      // Get price and supply in parallel
      const [price, supply] = await Promise.all([
        priceService.getTokenPrice(mintAddress),
        this.getTokenSupply(mintAddress),
      ]);

      if (!price || !supply) {
        logger.warn('Missing price or supply data', {
          mintAddress,
          hasPrice: !!price,
          hasSupply: !!supply,
        });
        return null;
      }

      // Calculate market cap and FDV
      const marketCap = supply.circulatingSupplyFormatted * price.priceUsd;
      const fullyDilutedValue = supply.totalSupplyFormatted * price.priceUsd;
      const marketCapSol = supply.circulatingSupplyFormatted * price.priceSol;
      const fdvSol = supply.totalSupplyFormatted * price.priceSol;

      const circulatingRatio = supply.totalSupplyFormatted > 0
        ? supply.circulatingSupplyFormatted / supply.totalSupplyFormatted
        : 1;

      const result: MarketCapInfo = {
        mintAddress,
        price,
        supply,
        marketCap,
        fullyDilutedValue,
        marketCapSol,
        fdvSol,
        circulatingRatio,
        timestamp: new Date(),
      };

      // Cache the result
      await cache.set(cacheKey, result, this.cacheTtl);

      logger.debug('Market cap calculated', {
        mintAddress,
        marketCap,
        fdv: fullyDilutedValue,
      });

      return result;
    } catch (error) {
      logger.error('Failed to calculate market cap', {
        mintAddress,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Get market cap for multiple tokens
   */
  async getBatchMarketCap(
    mintAddresses: string[]
  ): Promise<Map<string, MarketCapInfo>> {
    const results = new Map<string, MarketCapInfo>();

    // Process in batches to avoid overwhelming RPC
    const batchSize = 10;
    for (let i = 0; i < mintAddresses.length; i += batchSize) {
      const batch = mintAddresses.slice(i, i + batchSize);

      const batchResults = await Promise.all(
        batch.map(mint => this.getMarketCap(mint))
      );

      for (let j = 0; j < batch.length; j++) {
        const result = batchResults[j];
        if (result) {
          results.set(batch[j], result);
        }
      }
    }

    return results;
  }

  /**
   * Get market cap using token info from Shyft (includes metadata)
   */
  async getMarketCapWithMetadata(
    mintAddress: string
  ): Promise<(MarketCapInfo & { tokenInfo?: TokenInfo }) | null> {
    const [marketCap, tokenInfo] = await Promise.all([
      this.getMarketCap(mintAddress),
      shyftClient.getTokenInfo(mintAddress),
    ]);

    if (!marketCap) {
      return null;
    }

    return {
      ...marketCap,
      tokenInfo: tokenInfo || undefined,
    };
  }

  /**
   * Invalidate cached market cap
   */
  async invalidateCache(mintAddress: string): Promise<void> {
    await Promise.all([
      cache.del(`${MarketCapCalculator.CACHE_PREFIX}${mintAddress}`),
      cache.del(`${MarketCapCalculator.SUPPLY_CACHE_PREFIX}${mintAddress}`),
    ]);
  }

  /**
   * Format market cap for display
   */
  static formatMarketCap(value: number): string {
    if (value >= 1_000_000_000) {
      return `$${(value / 1_000_000_000).toFixed(2)}B`;
    }
    if (value >= 1_000_000) {
      return `$${(value / 1_000_000).toFixed(2)}M`;
    }
    if (value >= 1_000) {
      return `$${(value / 1_000).toFixed(2)}K`;
    }
    return `$${value.toFixed(2)}`;
  }

  /**
   * Calculate market cap tier
   */
  static getMarketCapTier(marketCap: number): string {
    if (marketCap >= 1_000_000_000) return 'large';     // $1B+
    if (marketCap >= 100_000_000) return 'mid';         // $100M+
    if (marketCap >= 10_000_000) return 'small';        // $10M+
    if (marketCap >= 1_000_000) return 'micro';         // $1M+
    return 'nano';                                       // <$1M
  }

  /**
   * Calculate FDV to market cap ratio
   */
  static getFdvRatio(info: MarketCapInfo): number {
    if (info.marketCap === 0) return 0;
    return info.fullyDilutedValue / info.marketCap;
  }
}

// Export singleton instance
export const marketCapCalculator = new MarketCapCalculator();

export default MarketCapCalculator;
