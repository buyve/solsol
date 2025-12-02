import { Worker, Job } from 'bullmq';
import { logger } from '../../../utils/logger.js';
import {
  connection,
  QUEUE_NAMES,
  CleanupJob,
} from '../QueueManager.js';
import { volumeAggregator } from '../../metrics/VolumeAggregator.js';
import { PriceRepository } from '../../repositories/PriceRepository.js';
import { HolderRepository } from '../../repositories/HolderRepository.js';
import { VolumeRepository } from '../../repositories/VolumeRepository.js';

let worker: Worker<CleanupJob> | null = null;
const priceRepository = new PriceRepository();
const holderRepository = new HolderRepository();
const volumeRepository = new VolumeRepository();

// Default retention periods in days
const DEFAULT_RETENTION = {
  prices: 30,      // Keep 30 days of price history
  holders: 90,     // Keep 90 days of holder snapshots
  volume: 30,      // Keep 30 days of volume stats
};

/**
 * Process cleanup job
 * Cleans up old data from Redis and database
 */
async function processCleanup(job: Job<CleanupJob>): Promise<void> {
  const { type, retentionDays } = job.data;

  logger.info(`Processing cleanup job`, {
    jobId: job.id,
    type,
    retentionDays,
  });

  const results: Record<string, number> = {};

  try {
    switch (type) {
      case 'holders':
        results.holders = await cleanupHolders(retentionDays);
        break;

      case 'volume':
        results.volumeRedis = await cleanupVolumeRedis();
        results.volumeDb = await cleanupVolumeDb(retentionDays);
        break;

      case 'prices':
        results.prices = await cleanupPrices(retentionDays);
        break;

      case 'all':
        results.holders = await cleanupHolders(retentionDays);
        results.volumeRedis = await cleanupVolumeRedis();
        results.volumeDb = await cleanupVolumeDb(retentionDays);
        results.prices = await cleanupPrices(retentionDays);
        break;

      default:
        logger.warn(`Unknown cleanup type: ${type}`);
    }

    logger.info(`Cleanup job completed`, {
      jobId: job.id,
      type,
      results,
    });
  } catch (error) {
    logger.error(`Cleanup job failed`, {
      error: (error as Error).message,
      type,
    });
    throw error;
  }
}

/**
 * Cleanup old holder snapshots
 */
async function cleanupHolders(retentionDays?: number): Promise<number> {
  const days = retentionDays ?? DEFAULT_RETENTION.holders;

  try {
    const deleted = await holderRepository.deleteOldSnapshots(days);
    logger.debug(`Cleaned up ${deleted} old holder snapshots`);
    return deleted;
  } catch (error) {
    logger.error('Failed to cleanup holder snapshots', {
      error: (error as Error).message,
    });
    return 0;
  }
}

/**
 * Cleanup old volume data from Redis
 */
async function cleanupVolumeRedis(): Promise<number> {
  try {
    const removed = await volumeAggregator.cleanup();
    logger.debug(`Cleaned up ${removed} old trades from Redis`);
    return removed;
  } catch (error) {
    logger.error('Failed to cleanup Redis volume data', {
      error: (error as Error).message,
    });
    return 0;
  }
}

/**
 * Cleanup old volume stats from database
 */
async function cleanupVolumeDb(retentionDays?: number): Promise<number> {
  const days = retentionDays ?? DEFAULT_RETENTION.volume;

  try {
    const deleted = await volumeRepository.deleteOldStats(days);
    logger.debug(`Cleaned up ${deleted} old volume stats from DB`);
    return deleted;
  } catch (error) {
    logger.error('Failed to cleanup DB volume stats', {
      error: (error as Error).message,
    });
    return 0;
  }
}

/**
 * Cleanup old price history
 */
async function cleanupPrices(retentionDays?: number): Promise<number> {
  const days = retentionDays ?? DEFAULT_RETENTION.prices;

  try {
    const deleted = await priceRepository.deleteOldPrices(days);
    logger.debug(`Cleaned up ${deleted} old price records`);
    return deleted;
  } catch (error) {
    logger.error('Failed to cleanup price history', {
      error: (error as Error).message,
    });
    return 0;
  }
}

/**
 * Start the cleanup worker
 */
export function startCleanupWorker(concurrency: number = 1): Worker<CleanupJob> {
  if (worker) {
    return worker;
  }

  worker = new Worker<CleanupJob>(
    QUEUE_NAMES.CLEANUP,
    processCleanup,
    {
      connection,
      concurrency,
      limiter: {
        max: 1,
        duration: 1000, // 1 job per second (cleanup is resource-intensive)
      },
    }
  );

  worker.on('completed', (job) => {
    logger.info(`Cleanup job ${job.id} completed`, { type: job.data.type });
  });

  worker.on('failed', (job, error) => {
    logger.error(`Cleanup job ${job?.id} failed`, {
      error: error.message,
      type: job?.data.type,
    });
  });

  worker.on('error', (error) => {
    logger.error('Cleanup worker error', { error: error.message });
  });

  logger.info('Cleanup worker started', { concurrency });

  return worker;
}

/**
 * Stop the cleanup worker
 */
export async function stopCleanupWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info('Cleanup worker stopped');
  }
}

export { worker as cleanupWorker };
