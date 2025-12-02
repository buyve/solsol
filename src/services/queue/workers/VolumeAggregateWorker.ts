import { Worker, Job } from 'bullmq';
import { logger } from '../../../utils/logger.js';
import {
  connection,
  QUEUE_NAMES,
  VolumeAggregateJob,
} from '../QueueManager.js';
import { volumeAggregator, TIME_WINDOWS } from '../../metrics/VolumeAggregator.js';
import { TokenRepository } from '../../repositories/TokenRepository.js';
import { VolumeRepository } from '../../repositories/VolumeRepository.js';

let worker: Worker<VolumeAggregateJob> | null = null;
const tokenRepository = new TokenRepository();
const volumeRepository = new VolumeRepository();

/**
 * Process volume aggregate job
 * Aggregates volume stats from Redis and persists to database
 */
async function processVolumeAggregate(job: Job<VolumeAggregateJob>): Promise<void> {
  const { mintAddress, priority } = job.data;

  logger.debug(`Processing volume aggregation for ${mintAddress}`, {
    jobId: job.id,
    priority,
  });

  try {
    // Get 24h volume stats from Redis
    const stats = await volumeAggregator.getVolumeStats(mintAddress, 'TWENTY_FOUR_HOUR');

    // Get or create token record
    let tokenId = await tokenRepository.getTokenIdByMint(mintAddress);

    if (!tokenId) {
      tokenId = await tokenRepository.upsertToken({
        mintAddress,
        isActive: true,
      });
    }

    if (tokenId && stats.tradeCount > 0) {
      // Save volume stats to database
      await volumeRepository.insertVolumeStats({
        tokenId,
        volume24hSol: stats.totalVolumeSol,
        volume24hUsd: stats.totalVolumeUsd,
        buyCount24h: stats.buyCount,
        sellCount24h: stats.sellCount,
        buyVolume24hSol: stats.buyVolumeSol,
        sellVolume24hSol: stats.sellVolumeSol,
      });

      // Cache the stats for quick access
      await volumeAggregator.cacheVolumeStats(stats, 60);

      logger.debug(`Volume stats saved for ${mintAddress}`, {
        volume24hUsd: stats.totalVolumeUsd.toFixed(2),
        tradeCount: stats.tradeCount,
      });
    }
  } catch (error) {
    logger.error(`Failed to aggregate volume for ${mintAddress}`, {
      error: (error as Error).message,
    });
    throw error;
  }
}

/**
 * Start the volume aggregate worker
 */
export function startVolumeAggregateWorker(concurrency: number = 3): Worker<VolumeAggregateJob> {
  if (worker) {
    return worker;
  }

  worker = new Worker<VolumeAggregateJob>(
    QUEUE_NAMES.VOLUME_AGGREGATE,
    processVolumeAggregate,
    {
      connection,
      concurrency,
      limiter: {
        max: 30,
        duration: 1000, // 30 jobs per second max
      },
    }
  );

  worker.on('completed', (job) => {
    logger.debug(`Volume aggregate job ${job.id} completed`);
  });

  worker.on('failed', (job, error) => {
    logger.error(`Volume aggregate job ${job?.id} failed`, {
      error: error.message,
      mintAddress: job?.data.mintAddress,
    });
  });

  worker.on('error', (error) => {
    logger.error('Volume aggregate worker error', { error: error.message });
  });

  logger.info('Volume aggregate worker started', { concurrency });

  return worker;
}

/**
 * Stop the volume aggregate worker
 */
export async function stopVolumeAggregateWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info('Volume aggregate worker stopped');
  }
}

export { worker as volumeAggregateWorker };
