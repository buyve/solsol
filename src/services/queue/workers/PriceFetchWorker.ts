import { Worker, Job } from 'bullmq';
import { logger } from '../../../utils/logger.js';
import {
  connection,
  QUEUE_NAMES,
  PriceFetchJob,
} from '../QueueManager.js';
import { priceService } from '../../pricing/PriceService.js';
import { marketCapCalculator } from '../../metrics/MarketCapCalculator.js';
import { TokenRepository } from '../../repositories/TokenRepository.js';
import { PriceRepository } from '../../repositories/PriceRepository.js';

let worker: Worker<PriceFetchJob> | null = null;
const tokenRepository = new TokenRepository();
const priceRepository = new PriceRepository();

/**
 * Process price fetch job
 * Fetches prices for multiple tokens and persists to database
 */
async function processPriceFetch(job: Job<PriceFetchJob>): Promise<void> {
  const { mintAddresses, priority } = job.data;

  logger.debug(`Processing price fetch for ${mintAddresses.length} tokens`, {
    jobId: job.id,
    priority,
  });

  const results: Array<{ mint: string; success: boolean; error?: string }> = [];

  for (const mintAddress of mintAddresses) {
    try {
      // Fetch current price
      const price = await priceService.getTokenPrice(mintAddress);

      if (price) {
        // Get or create token record
        let tokenId = await tokenRepository.getTokenIdByMint(mintAddress);

        if (!tokenId) {
          // Create token record if not exists
          tokenId = await tokenRepository.upsertToken({
            mintAddress,
            isActive: true,
          });
        }

        if (tokenId) {
          // Save price to database
          await priceRepository.insertPrice({
            tokenId,
            priceSol: price.priceSol,
            priceUsd: price.priceUsd,
            solUsdRate: price.solUsdRate,
          });

          // Calculate and save market cap
          const marketCapInfo = await marketCapCalculator.getMarketCap(mintAddress);

          if (marketCapInfo) {
            // Save market cap history
            await priceRepository.insertMarketCap({
              tokenId,
              marketCapUsd: marketCapInfo.marketCap,
              fdvUsd: marketCapInfo.fullyDilutedValue,
              circulatingSupply: marketCapInfo.supply.circulatingSupplyFormatted.toString(),
            });

            // Update token record with latest market cap
            await tokenRepository.updateTokenMarketCap(
              tokenId,
              marketCapInfo.marketCap,
              marketCapInfo.fullyDilutedValue
            );
          }

          results.push({ mint: mintAddress, success: true });

          logger.debug(`Price saved for ${mintAddress}`, {
            priceUsd: price.priceUsd,
            priceSol: price.priceSol,
            marketCap: marketCapInfo?.marketCap,
            fdv: marketCapInfo?.fullyDilutedValue,
          });
        }
      } else {
        results.push({ mint: mintAddress, success: false, error: 'No price data' });
      }
    } catch (error) {
      const errorMessage = (error as Error).message;
      results.push({ mint: mintAddress, success: false, error: errorMessage });
      logger.error(`Failed to fetch/save price for ${mintAddress}`, { error: errorMessage });
    }
  }

  const successCount = results.filter(r => r.success).length;
  logger.debug(`Price fetch job completed`, {
    jobId: job.id,
    total: mintAddresses.length,
    success: successCount,
    failed: mintAddresses.length - successCount,
  });
}

/**
 * Start the price fetch worker
 */
export function startPriceFetchWorker(concurrency: number = 3): Worker<PriceFetchJob> {
  if (worker) {
    return worker;
  }

  worker = new Worker<PriceFetchJob>(
    QUEUE_NAMES.PRICE_FETCH,
    processPriceFetch,
    {
      connection,
      concurrency,
      limiter: {
        max: 20,
        duration: 1000, // 20 jobs per second max
      },
    }
  );

  worker.on('completed', (job) => {
    logger.debug(`Price fetch job ${job.id} completed`);
  });

  worker.on('failed', (job, error) => {
    logger.error(`Price fetch job ${job?.id} failed`, {
      error: error.message,
      mintCount: job?.data.mintAddresses.length,
    });
  });

  worker.on('error', (error) => {
    logger.error('Price fetch worker error', { error: error.message });
  });

  logger.info('Price fetch worker started', { concurrency });

  return worker;
}

/**
 * Stop the price fetch worker
 */
export async function stopPriceFetchWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info('Price fetch worker stopped');
  }
}

export { worker as priceFetchWorker };
