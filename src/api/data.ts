import { Router, Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import { TokenRepository } from '../services/repositories/TokenRepository.js';
import { PriceRepository } from '../services/repositories/PriceRepository.js';
import { HolderRepository } from '../services/repositories/HolderRepository.js';
import { VolumeRepository } from '../services/repositories/VolumeRepository.js';
import { PoolRepository } from '../services/repositories/PoolRepository.js';
import { TransactionRepository } from '../services/repositories/TransactionRepository.js';
import { volumeAggregator } from '../services/metrics/VolumeAggregator.js';
import { marketCapCalculator, MarketCapCalculator } from '../services/metrics/MarketCapCalculator.js';

const router = Router();

// Repository instances
const tokenRepository = new TokenRepository();
const priceRepository = new PriceRepository();
const holderRepository = new HolderRepository();
const volumeRepository = new VolumeRepository();
const poolRepository = new PoolRepository();
const transactionRepository = new TransactionRepository();

/**
 * GET /api/tokens/:mint
 * Get token information by mint address
 */
router.get('/tokens/:mint', async (req: Request, res: Response) => {
  try {
    const { mint } = req.params;
    const token = await tokenRepository.getByMint(mint);

    if (!token) {
      res.status(404).json({ error: 'Token not found' });
      return;
    }

    // Get latest price and market cap
    const latestPrice = await priceRepository.getLatestPrice(token.id);
    const latestMarketCap = await priceRepository.getLatestMarketCap(token.id);

    res.json({
      token,
      price: latestPrice,
      marketCap: latestMarketCap,
    });
  } catch (error) {
    logger.error('Failed to get token', { error: (error as Error).message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/tokens/recent
 * Get recently created tokens
 */
router.get('/tokens/recent', async (req: Request, res: Response) => {
  try {
    const hours = parseInt(req.query.hours as string) || 24;
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);

    const tokens = await tokenRepository.getRecentTokens(hours, limit);
    res.json({ tokens, count: tokens.length });
  } catch (error) {
    logger.error('Failed to get recent tokens', { error: (error as Error).message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/tokens/search
 * Search tokens by name or symbol
 */
router.get('/tokens/search', async (req: Request, res: Response) => {
  try {
    const { q } = req.query;

    if (!q || typeof q !== 'string') {
      res.status(400).json({ error: 'Search query required' });
      return;
    }

    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const tokens = await tokenRepository.searchTokens(q, limit);

    res.json({ tokens, count: tokens.length });
  } catch (error) {
    logger.error('Failed to search tokens', { error: (error as Error).message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/prices/:mint
 * Get price data for a token
 */
router.get('/prices/:mint', async (req: Request, res: Response) => {
  try {
    const { mint } = req.params;
    const token = await tokenRepository.getByMint(mint);

    if (!token) {
      res.status(404).json({ error: 'Token not found' });
      return;
    }

    const hours = parseInt(req.query.hours as string) || 24;
    const [latest, history, change24h] = await Promise.all([
      priceRepository.getLatestPrice(token.id),
      priceRepository.getPriceHistory(token.id, hours),
      priceRepository.getPriceChange(token.id, 24),
    ]);

    res.json({
      mint,
      latest,
      history,
      change24h,
    });
  } catch (error) {
    logger.error('Failed to get prices', { error: (error as Error).message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/marketcap/:mint
 * Get market cap data for a token (real-time calculation)
 */
router.get('/marketcap/:mint', async (req: Request, res: Response) => {
  try {
    const { mint } = req.params;
    const marketCap = await marketCapCalculator.getMarketCapWithMetadata(mint);

    if (!marketCap) {
      res.status(404).json({ error: 'Market cap data not available' });
      return;
    }

    res.json({
      mint,
      marketCap: marketCap.marketCap,
      fdv: marketCap.fullyDilutedValue,
      marketCapFormatted: MarketCapCalculator.formatMarketCap(marketCap.marketCap),
      tier: MarketCapCalculator.getMarketCapTier(marketCap.marketCap),
      price: marketCap.price,
      supply: {
        circulating: marketCap.supply.circulatingSupplyFormatted,
        total: marketCap.supply.totalSupplyFormatted,
        ratio: marketCap.circulatingRatio,
      },
      tokenInfo: marketCap.tokenInfo,
      timestamp: marketCap.timestamp,
    });
  } catch (error) {
    logger.error('Failed to get market cap', { error: (error as Error).message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/volume/:mint
 * Get volume data for a token
 */
router.get('/volume/:mint', async (req: Request, res: Response) => {
  try {
    const { mint } = req.params;

    // Get real-time volume from Redis aggregator
    const [volume1h, volume24h] = await Promise.all([
      volumeAggregator.getVolumeStats(mint, 'ONE_HOUR'),
      volumeAggregator.getVolumeStats(mint, 'TWENTY_FOUR_HOUR'),
    ]);

    // Get historical volume from DB
    const token = await tokenRepository.getByMint(mint);
    let dbVolume = null;
    if (token) {
      dbVolume = await volumeRepository.getLatestVolume(token.id);
    }

    res.json({
      mint,
      realtime: {
        '1h': volume1h,
        '24h': volume24h,
      },
      historical: dbVolume,
    });
  } catch (error) {
    logger.error('Failed to get volume', { error: (error as Error).message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/holders/:mint
 * Get holder data for a token
 */
router.get('/holders/:mint', async (req: Request, res: Response) => {
  try {
    const { mint } = req.params;
    const token = await tokenRepository.getByMint(mint);

    if (!token) {
      res.status(404).json({ error: 'Token not found' });
      return;
    }

    const [latestSnapshot, topHolders] = await Promise.all([
      holderRepository.getLatestSnapshot(token.id),
      holderRepository.getTopHolders(token.id, 50),
    ]);

    res.json({
      mint,
      snapshot: latestSnapshot,
      topHolders,
    });
  } catch (error) {
    logger.error('Failed to get holders', { error: (error as Error).message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/holders/:mint/history
 * Get holder distribution history
 */
router.get('/holders/:mint/history', async (req: Request, res: Response) => {
  try {
    const { mint } = req.params;
    const token = await tokenRepository.getByMint(mint);

    if (!token) {
      res.status(404).json({ error: 'Token not found' });
      return;
    }

    const hours = parseInt(req.query.hours as string) || 24;
    const history = await holderRepository.getSnapshotHistory(token.id, hours);

    res.json({
      mint,
      history,
    });
  } catch (error) {
    logger.error('Failed to get holder history', { error: (error as Error).message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/pools/:mint
 * Get pool/liquidity data for a token
 */
router.get('/pools/:mint', async (req: Request, res: Response) => {
  try {
    const { mint } = req.params;
    const token = await tokenRepository.getByMint(mint);

    if (!token) {
      res.status(404).json({ error: 'Token not found' });
      return;
    }

    const pools = await poolRepository.getPoolsByToken(token.id);

    res.json({
      mint,
      pools,
      count: pools.length,
    });
  } catch (error) {
    logger.error('Failed to get pools', { error: (error as Error).message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/transactions/:mint
 * Get recent transactions for a token
 */
router.get('/transactions/:mint', async (req: Request, res: Response) => {
  try {
    const { mint } = req.params;
    const token = await tokenRepository.getByMint(mint);

    if (!token) {
      res.status(404).json({ error: 'Token not found' });
      return;
    }

    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const txType = req.query.type as string;

    const transactions = await transactionRepository.getRecentTransactions(
      token.id,
      limit,
      txType
    );

    res.json({
      mint,
      transactions,
      count: transactions.length,
    });
  } catch (error) {
    logger.error('Failed to get transactions', { error: (error as Error).message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/summary/:mint
 * Get comprehensive token summary (for trading bots)
 */
router.get('/summary/:mint', async (req: Request, res: Response) => {
  try {
    const { mint } = req.params;
    const token = await tokenRepository.getByMint(mint);

    if (!token) {
      res.status(404).json({ error: 'Token not found' });
      return;
    }

    // Fetch all data in parallel
    const [
      latestPrice,
      latestMarketCap,
      priceChange24h,
      volume1h,
      volume24h,
      holderSnapshot,
      pools,
      recentTxCount,
    ] = await Promise.all([
      priceRepository.getLatestPrice(token.id),
      priceRepository.getLatestMarketCap(token.id),
      priceRepository.getPriceChange(token.id, 24),
      volumeAggregator.getVolumeStats(mint, 'ONE_HOUR'),
      volumeAggregator.getVolumeStats(mint, 'TWENTY_FOUR_HOUR'),
      holderRepository.getLatestSnapshot(token.id),
      poolRepository.getPoolsByToken(token.id),
      transactionRepository.getTransactionCount(token.id, 24),
    ]);

    res.json({
      token: {
        mint: token.mintAddress,
        name: token.name,
        symbol: token.symbol,
        decimals: token.decimals,
        launchPlatform: token.launchPlatform,
        createdAt: token.createdAt,
      },
      price: latestPrice ? {
        usd: latestPrice.priceUsd,
        sol: latestPrice.priceSol,
        change24h: priceChange24h,
        timestamp: latestPrice.timestamp,
      } : null,
      marketCap: latestMarketCap ? {
        usd: latestMarketCap.marketCapUsd,
        fdv: latestMarketCap.fdvUsd,
        timestamp: latestMarketCap.timestamp,
      } : null,
      volume: {
        '1h': volume1h,
        '24h': volume24h,
      },
      holders: holderSnapshot ? {
        total: holderSnapshot.totalHolders,
        top10Pct: holderSnapshot.top10Percentage,
        top20Pct: holderSnapshot.top20Percentage,
        gini: holderSnapshot.giniCoefficient,
        timestamp: holderSnapshot.snapshotTime,
      } : null,
      liquidity: {
        poolCount: pools.length,
        pools: pools.map((p: { poolAddress: string; dexName: string; liquidityUsd: number }) => ({
          address: p.poolAddress,
          dex: p.dexName,
          liquidity: p.liquidityUsd,
        })),
      },
      activity: {
        txCount24h: recentTxCount,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Failed to get token summary', { error: (error as Error).message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/trending
 * Get trending tokens based on volume and activity
 */
router.get('/trending', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const hours = parseInt(req.query.hours as string) || 24;

    // Get top tokens by volume from DB
    const topByVolume = await volumeRepository.getTopByVolume(hours, limit);

    res.json({
      trending: topByVolume,
      period: `${hours}h`,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Failed to get trending', { error: (error as Error).message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export const dataRouter: Router = router;
