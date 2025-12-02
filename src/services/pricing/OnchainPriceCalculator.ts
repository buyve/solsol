import { Connection, PublicKey } from '@solana/web3.js';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { cache } from '../../config/redis.js';
import { shyftClient } from '../external/ShyftClient.js';

// Well-known token mints
export const KNOWN_MINTS = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
};

// Pool account layouts (Raydium AMM V4)
// Reference: https://github.com/raydium-io/raydium-amm
const RAYDIUM_AMM_LAYOUT_OFFSETS = {
  baseVault: 72,
  quoteVault: 104,
  baseMint: 400,
  quoteMint: 432,
  baseDecimals: 392,
  quoteDecimals: 393,
};

export interface PoolReserves {
  baseReserve: bigint;
  quoteReserve: bigint;
  baseDecimals: number;
  quoteDecimals: number;
  baseMint: string;
  quoteMint: string;
  baseVault: string;
  quoteVault: string;
}

export interface OnchainPrice {
  price: number;
  priceInQuote: number;
  quoteMint: string;
  pool: string;
  source: 'raydium' | 'shyft';
  timestamp: Date;
}

export interface OnchainPriceCalculatorOptions {
  rpcEndpoint?: string;
}

export class OnchainPriceCalculator {
  private connection: Connection;
  private static readonly CACHE_TTL = 15; // 15 seconds for on-chain prices

  constructor(options?: OnchainPriceCalculatorOptions) {
    const endpoint = options?.rpcEndpoint || config.solana.rpcUrl;
    this.connection = new Connection(endpoint, 'confirmed');
  }

  /**
   * Calculate price from Raydium pool reserves
   */
  async getPriceFromRaydiumPool(
    poolAddress: string,
    targetMint: string
  ): Promise<OnchainPrice | null> {
    try {
      const cacheKey = `onchain:raydium:${poolAddress}:${targetMint}`;
      const cached = await cache.get<OnchainPrice>(cacheKey);

      if (cached) {
        return cached;
      }

      // Get pool account data
      const poolPubkey = new PublicKey(poolAddress);
      const accountInfo = await this.connection.getAccountInfo(poolPubkey);

      if (!accountInfo?.data) {
        logger.warn('Raydium pool account not found', { poolAddress });
        return null;
      }

      // Parse pool data including vault addresses
      const reserves = this.parseRaydiumPoolData(accountInfo.data);

      if (!reserves) {
        return null;
      }

      // Get vault balances by reading directly from vault token accounts
      const [baseBalance, quoteBalance] = await Promise.all([
        this.getVaultBalance(reserves.baseVault),
        this.getVaultBalance(reserves.quoteVault),
      ]);

      if (baseBalance === null || quoteBalance === null) {
        logger.warn('Failed to get vault balances', { poolAddress });
        return null;
      }

      // Calculate price based on reserves
      const baseAmount = Number(baseBalance) / Math.pow(10, reserves.baseDecimals);
      const quoteAmount = Number(quoteBalance) / Math.pow(10, reserves.quoteDecimals);

      let price: number;
      let priceInQuote: number;
      let quoteMint: string;

      if (reserves.baseMint === targetMint) {
        // Target is base token, price in quote
        priceInQuote = quoteAmount / baseAmount;
        quoteMint = reserves.quoteMint;
        price = priceInQuote;
      } else if (reserves.quoteMint === targetMint) {
        // Target is quote token, price in base
        priceInQuote = baseAmount / quoteAmount;
        quoteMint = reserves.baseMint;
        price = priceInQuote;
      } else {
        logger.warn('Target mint not found in pool', { targetMint, poolAddress });
        return null;
      }

      const result: OnchainPrice = {
        price,
        priceInQuote,
        quoteMint,
        pool: poolAddress,
        source: 'raydium',
        timestamp: new Date(),
      };

      await cache.set(cacheKey, result, OnchainPriceCalculator.CACHE_TTL);
      return result;
    } catch (error) {
      logger.error('Failed to get Raydium pool price', {
        poolAddress,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Calculate price using Shyft pool data (simpler approach)
   */
  async getPriceFromShyftPool(
    poolAddress: string,
    targetMint: string
  ): Promise<OnchainPrice | null> {
    try {
      const cacheKey = `onchain:shyft:${poolAddress}:${targetMint}`;
      const cached = await cache.get<OnchainPrice>(cacheKey);

      if (cached) {
        return cached;
      }

      const poolInfo = await shyftClient.getPoolInfo(poolAddress);

      if (!poolInfo) {
        return null;
      }

      // Calculate price from reserves
      const baseAmount = parseFloat(poolInfo.baseReserve);
      const quoteAmount = parseFloat(poolInfo.quoteReserve);

      let price: number;
      let priceInQuote: number;
      let quoteMint: string;

      if (poolInfo.baseMint === targetMint) {
        priceInQuote = quoteAmount / baseAmount;
        quoteMint = poolInfo.quoteMint;
        price = priceInQuote;
      } else if (poolInfo.quoteMint === targetMint) {
        priceInQuote = baseAmount / quoteAmount;
        quoteMint = poolInfo.baseMint;
        price = priceInQuote;
      } else {
        return null;
      }

      const result: OnchainPrice = {
        price,
        priceInQuote,
        quoteMint,
        pool: poolInfo.poolAddress,
        source: 'shyft',
        timestamp: new Date(),
      };

      await cache.set(cacheKey, result, OnchainPriceCalculator.CACHE_TTL);
      return result;
    } catch (error) {
      logger.error('Failed to get Shyft pool price', {
        poolAddress,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Calculate USD price from pool data and SOL/USD rate
   */
  async calculateUsdPrice(
    onchainPrice: OnchainPrice,
    solUsdRate: number
  ): Promise<number | null> {
    // If quote is SOL, convert directly
    if (onchainPrice.quoteMint === KNOWN_MINTS.SOL) {
      return onchainPrice.priceInQuote * solUsdRate;
    }

    // If quote is USDC or USDT, use directly
    if (
      onchainPrice.quoteMint === KNOWN_MINTS.USDC ||
      onchainPrice.quoteMint === KNOWN_MINTS.USDT
    ) {
      return onchainPrice.priceInQuote;
    }

    // For other quote tokens, try to find their USD value
    // This would require recursive lookup, simplified for now
    logger.warn('Unable to calculate USD price for quote token', {
      quoteMint: onchainPrice.quoteMint,
    });
    return null;
  }

  /**
   * Parse Raydium AMM V4 pool data including vault addresses
   */
  private parseRaydiumPoolData(data: Buffer): PoolReserves | null {
    try {
      if (data.length < 500) {
        return null;
      }

      // Extract vault addresses (these are the actual token accounts holding reserves)
      const baseVault = new PublicKey(
        data.subarray(
          RAYDIUM_AMM_LAYOUT_OFFSETS.baseVault,
          RAYDIUM_AMM_LAYOUT_OFFSETS.baseVault + 32
        )
      ).toBase58();

      const quoteVault = new PublicKey(
        data.subarray(
          RAYDIUM_AMM_LAYOUT_OFFSETS.quoteVault,
          RAYDIUM_AMM_LAYOUT_OFFSETS.quoteVault + 32
        )
      ).toBase58();

      const baseMint = new PublicKey(
        data.subarray(
          RAYDIUM_AMM_LAYOUT_OFFSETS.baseMint,
          RAYDIUM_AMM_LAYOUT_OFFSETS.baseMint + 32
        )
      ).toBase58();

      const quoteMint = new PublicKey(
        data.subarray(
          RAYDIUM_AMM_LAYOUT_OFFSETS.quoteMint,
          RAYDIUM_AMM_LAYOUT_OFFSETS.quoteMint + 32
        )
      ).toBase58();

      const baseDecimals = data[RAYDIUM_AMM_LAYOUT_OFFSETS.baseDecimals];
      const quoteDecimals = data[RAYDIUM_AMM_LAYOUT_OFFSETS.quoteDecimals];

      return {
        baseReserve: BigInt(0), // Will be fetched from vault
        quoteReserve: BigInt(0),
        baseDecimals,
        quoteDecimals,
        baseMint,
        quoteMint,
        baseVault,
        quoteVault,
      };
    } catch (error) {
      logger.error('Failed to parse Raydium pool data', {
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Get token balance directly from a vault token account
   * The vault address IS the token account, not the owner
   */
  private async getVaultBalance(vaultAddress: string): Promise<bigint | null> {
    try {
      const vaultPubkey = new PublicKey(vaultAddress);
      const accountInfo = await this.connection.getAccountInfo(vaultPubkey);

      if (!accountInfo?.data) {
        logger.warn('Vault account not found', { vaultAddress });
        return null;
      }

      // SPL Token account layout:
      // - mint: 32 bytes (offset 0)
      // - owner: 32 bytes (offset 32)
      // - amount: 8 bytes (offset 64)
      // Total minimum size: 165 bytes
      if (accountInfo.data.length < 72) {
        logger.warn('Invalid vault account data', {
          vaultAddress,
          dataLength: accountInfo.data.length,
        });
        return null;
      }

      // Amount is at offset 64, 8 bytes (u64 little-endian)
      const amount = accountInfo.data.readBigUInt64LE(64);
      return amount;
    } catch (error) {
      logger.error('Failed to get vault balance', {
        vaultAddress,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Find pools for a given token mint
   */
  async findPoolsForToken(mintAddress: string): Promise<string[]> {
    try {
      // Use Shyft to find pools
      const pools = await shyftClient.getPoolsByToken(mintAddress);
      return pools.map((p: { poolAddress: string }) => p.poolAddress);
    } catch (error) {
      logger.error('Failed to find pools for token', {
        mintAddress,
        error: (error as Error).message,
      });
      return [];
    }
  }

  /**
   * Get best price across multiple pools
   */
  async getBestPrice(mintAddress: string): Promise<OnchainPrice | null> {
    const pools = await this.findPoolsForToken(mintAddress);

    if (pools.length === 0) {
      return null;
    }

    let bestPrice: OnchainPrice | null = null;
    let highestLiquidity = 0;

    for (const poolAddress of pools.slice(0, 5)) {
      // Check top 5 pools
      const price = await this.getPriceFromShyftPool(poolAddress, mintAddress);

      if (price) {
        // Simple heuristic: prefer SOL or stable quote tokens
        const isPriorityQuote =
          price.quoteMint === KNOWN_MINTS.SOL ||
          price.quoteMint === KNOWN_MINTS.USDC ||
          price.quoteMint === KNOWN_MINTS.USDT;

        if (isPriorityQuote) {
          bestPrice = price;
          break;
        }

        if (!bestPrice) {
          bestPrice = price;
        }
      }
    }

    return bestPrice;
  }
}

// Export singleton instance
export const onchainPriceCalculator = new OnchainPriceCalculator();

export default OnchainPriceCalculator;
