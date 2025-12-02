import { Connection, PublicKey } from '@solana/web3.js';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { cache } from '../../config/redis.js';
import { shyftClient, TokenHolder } from '../external/ShyftClient.js';

export interface HolderInfo {
  address: string;
  balance: number;
  balanceRaw: string;
  percentage: number;
  rank: number;
}

export interface HolderAnalysis {
  mintAddress: string;
  totalHolders: number;
  holders: HolderInfo[];
  top10Percentage: number;
  top20Percentage: number;
  top50Percentage: number;
  giniCoefficient: number;
  timestamp: Date;
}

export interface HolderScannerOptions {
  rpcEndpoint?: string;
  maxHolders?: number;
  cacheTtl?: number;
}

// Token maturity thresholds for dynamic polling
const MATURITY_THRESHOLDS = {
  NEW: 60,           // < 1 hour old: poll every 1 minute
  YOUNG: 300,        // 1-6 hours: poll every 5 minutes
  GROWING: 900,      // 6-24 hours: poll every 15 minutes
  MATURE: 3600,      // > 24 hours: poll every 1 hour
};

export class HolderScanner {
  private connection: Connection;
  private maxHolders: number;
  private cacheTtl: number;
  private static readonly CACHE_PREFIX = 'holders:';
  private static readonly ANALYSIS_PREFIX = 'holders:analysis:';

  constructor(options?: HolderScannerOptions) {
    const endpoint = options?.rpcEndpoint || config.solana.rpcUrl;
    this.connection = new Connection(endpoint, 'confirmed');
    this.maxHolders = options?.maxHolders || 1000;
    this.cacheTtl = options?.cacheTtl || 60; // 1 minute default
  }

  /**
   * Get all holders for a token using Shyft API
   */
  async getHolders(mintAddress: string): Promise<HolderInfo[]> {
    // Check cache first
    const cacheKey = `${HolderScanner.CACHE_PREFIX}${mintAddress}`;
    const cached = await cache.get<HolderInfo[]>(cacheKey);

    if (cached) {
      return cached;
    }

    try {
      // Use Shyft to get holders
      const shyftHolders = await shyftClient.getAllHolders(mintAddress, {
        maxPages: Math.ceil(this.maxHolders / 100),
        pageSize: 100,
      });

      if (!shyftHolders || shyftHolders.length === 0) {
        // Fallback to RPC method
        return this.getHoldersFromRpc(mintAddress);
      }

      // Calculate total supply for percentage
      const totalBalance = shyftHolders.reduce(
        (sum: number, h: TokenHolder) => sum + parseFloat(h.balance),
        0
      );

      const holders: HolderInfo[] = shyftHolders.map(
        (holder: TokenHolder, index: number) => ({
          address: holder.address,
          balance: parseFloat(holder.balance),
          balanceRaw: holder.balance,
          percentage: totalBalance > 0 ? (parseFloat(holder.balance) / totalBalance) * 100 : 0,
          rank: index + 1,
        })
      );

      // Sort by balance descending
      holders.sort((a, b) => b.balance - a.balance);

      // Update ranks after sorting
      holders.forEach((h, i) => (h.rank = i + 1));

      // Cache the results
      await cache.set(cacheKey, holders, this.cacheTtl);

      logger.debug('Holders fetched from Shyft', {
        mint: mintAddress,
        count: holders.length,
      });

      return holders;
    } catch (error) {
      logger.error('Failed to get holders from Shyft', {
        mintAddress,
        error: (error as Error).message,
      });

      // Try RPC fallback
      return this.getHoldersFromRpc(mintAddress);
    }
  }

  /**
   * Fallback: Get holders using RPC getProgramAccounts
   */
  private async getHoldersFromRpc(mintAddress: string): Promise<HolderInfo[]> {
    try {
      const mintPubkey = new PublicKey(mintAddress);

      // Get all token accounts for this mint
      const accounts = await this.connection.getProgramAccounts(
        new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
        {
          filters: [
            { dataSize: 165 }, // Token account size
            {
              memcmp: {
                offset: 0, // Mint address offset
                bytes: mintPubkey.toBase58(),
              },
            },
          ],
        }
      );

      const holders: HolderInfo[] = [];
      let totalBalance = BigInt(0);

      for (const account of accounts) {
        const data = account.account.data;
        // Owner is at offset 32, 32 bytes
        const owner = new PublicKey(data.subarray(32, 64)).toBase58();
        // Amount is at offset 64, 8 bytes (u64)
        const amount = data.readBigUInt64LE(64);

        if (amount > 0n) {
          totalBalance += amount;
          holders.push({
            address: owner,
            balance: Number(amount),
            balanceRaw: amount.toString(),
            percentage: 0, // Will calculate after
            rank: 0,
          });
        }
      }

      // Sort by balance descending
      holders.sort((a, b) => b.balance - a.balance);

      // Calculate percentages and ranks
      const totalBalanceNum = Number(totalBalance);
      holders.forEach((h, i) => {
        h.percentage = totalBalanceNum > 0 ? (h.balance / totalBalanceNum) * 100 : 0;
        h.rank = i + 1;
      });

      // Limit to maxHolders
      const limitedHolders = holders.slice(0, this.maxHolders);

      // Cache the results
      const cacheKey = `${HolderScanner.CACHE_PREFIX}${mintAddress}`;
      await cache.set(cacheKey, limitedHolders, this.cacheTtl);

      logger.debug('Holders fetched from RPC', {
        mint: mintAddress,
        total: accounts.length,
        returned: limitedHolders.length,
      });

      return limitedHolders;
    } catch (error) {
      logger.error('Failed to get holders from RPC', {
        mintAddress,
        error: (error as Error).message,
      });
      return [];
    }
  }

  /**
   * Analyze holder distribution
   */
  async analyzeHolders(mintAddress: string): Promise<HolderAnalysis | null> {
    // Check cache first
    const cacheKey = `${HolderScanner.ANALYSIS_PREFIX}${mintAddress}`;
    const cached = await cache.get<HolderAnalysis>(cacheKey);

    if (cached) {
      return cached;
    }

    const holders = await this.getHolders(mintAddress);

    if (holders.length === 0) {
      return null;
    }

    // Calculate top holder percentages
    const top10 = holders.slice(0, 10);
    const top20 = holders.slice(0, 20);
    const top50 = holders.slice(0, 50);

    const top10Percentage = top10.reduce((sum, h) => sum + h.percentage, 0);
    const top20Percentage = top20.reduce((sum, h) => sum + h.percentage, 0);
    const top50Percentage = top50.reduce((sum, h) => sum + h.percentage, 0);

    // Calculate Gini coefficient
    const giniCoefficient = this.calculateGiniCoefficient(holders);

    const analysis: HolderAnalysis = {
      mintAddress,
      totalHolders: holders.length,
      holders: holders.slice(0, 100), // Store top 100 only
      top10Percentage,
      top20Percentage,
      top50Percentage,
      giniCoefficient,
      timestamp: new Date(),
    };

    // Cache the analysis
    await cache.set(cacheKey, analysis, this.cacheTtl * 2); // Cache analysis longer

    logger.debug('Holder analysis completed', {
      mint: mintAddress,
      totalHolders: holders.length,
      top10Pct: top10Percentage.toFixed(2),
      gini: giniCoefficient.toFixed(4),
    });

    return analysis;
  }

  /**
   * Calculate Gini coefficient for wealth distribution
   * 0 = perfect equality, 1 = perfect inequality
   */
  private calculateGiniCoefficient(holders: HolderInfo[]): number {
    if (holders.length === 0) return 0;
    if (holders.length === 1) return 0;

    const n = holders.length;
    const balances = holders.map(h => h.balance).sort((a, b) => a - b);
    const totalBalance = balances.reduce((sum, b) => sum + b, 0);

    if (totalBalance === 0) return 0;

    let sumOfDifferences = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        sumOfDifferences += Math.abs(balances[i] - balances[j]);
      }
    }

    return sumOfDifferences / (2 * n * n * (totalBalance / n));
  }

  /**
   * Get top holders
   */
  async getTopHolders(
    mintAddress: string,
    limit: number = 10
  ): Promise<HolderInfo[]> {
    const holders = await this.getHolders(mintAddress);
    return holders.slice(0, limit);
  }

  /**
   * Get dynamic polling interval based on token age
   */
  static getPollingInterval(tokenAgeSeconds: number): number {
    if (tokenAgeSeconds < 3600) {
      return MATURITY_THRESHOLDS.NEW; // 1 minute for new tokens
    }
    if (tokenAgeSeconds < 6 * 3600) {
      return MATURITY_THRESHOLDS.YOUNG; // 5 minutes for 1-6 hour old
    }
    if (tokenAgeSeconds < 24 * 3600) {
      return MATURITY_THRESHOLDS.GROWING; // 15 minutes for 6-24 hour old
    }
    return MATURITY_THRESHOLDS.MATURE; // 1 hour for mature tokens
  }

  /**
   * Check if holder distribution is concerning (potential rug)
   */
  static isDistributionConcerning(analysis: HolderAnalysis): {
    isConcerning: boolean;
    reasons: string[];
  } {
    const reasons: string[] = [];

    // Check top 10 concentration
    if (analysis.top10Percentage > 80) {
      reasons.push(`Top 10 holders own ${analysis.top10Percentage.toFixed(1)}%`);
    }

    // Check single holder dominance
    if (analysis.holders.length > 0 && analysis.holders[0].percentage > 50) {
      reasons.push(
        `Single holder owns ${analysis.holders[0].percentage.toFixed(1)}%`
      );
    }

    // Check Gini coefficient
    if (analysis.giniCoefficient > 0.9) {
      reasons.push(`High inequality (Gini: ${analysis.giniCoefficient.toFixed(2)})`);
    }

    // Check low holder count
    if (analysis.totalHolders < 50) {
      reasons.push(`Very few holders: ${analysis.totalHolders}`);
    }

    return {
      isConcerning: reasons.length > 0,
      reasons,
    };
  }

  /**
   * Invalidate cached holders
   */
  async invalidateCache(mintAddress: string): Promise<void> {
    await Promise.all([
      cache.del(`${HolderScanner.CACHE_PREFIX}${mintAddress}`),
      cache.del(`${HolderScanner.ANALYSIS_PREFIX}${mintAddress}`),
    ]);
  }
}

// Export singleton instance
export const holderScanner = new HolderScanner();

export default HolderScanner;
