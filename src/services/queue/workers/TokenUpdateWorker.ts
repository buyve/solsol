import { Worker, Job } from 'bullmq';
import { logger } from '../../../utils/logger.js';
import {
  connection,
  QUEUE_NAMES,
  TokenUpdateJob,
  PRIORITIES,
  Priority,
  addJob,
} from '../QueueManager.js';
import { priceService } from '../../pricing/PriceService.js';
import { holderScanner } from '../../holders/HolderScanner.js';
import { holderSnapshot } from '../../holders/HolderSnapshot.js';
import { volumeAggregator } from '../../metrics/VolumeAggregator.js';

let worker: Worker<TokenUpdateJob> | null = null;

/**
 * Process token update job
 */
async function processTokenUpdate(job: Job<TokenUpdateJob>): Promise<void> {
  const { mintAddress, updatePrice, updateHolders, updateVolume } = job.data;

  logger.debug(`Processing token update for ${mintAddress}`, {
    jobId: job.id,
    priority: job.data.priority,
  });

  const tasks: Promise<void>[] = [];

  // Update price
  if (updatePrice !== false) {
    tasks.push(
      priceService.getTokenPrice(mintAddress).then((price) => {
        if (price) {
          logger.debug(`Price updated for ${mintAddress}`, {
            priceUsd: price.priceUsd,
          });
        }
      })
    );
  }

  // Update holders
  if (updateHolders) {
    tasks.push(
      holderScanner.analyzeHolders(mintAddress).then((analysis) => {
        if (analysis) {
          logger.debug(`Holders analyzed for ${mintAddress}`, {
            count: analysis.totalHolders,
          });
        }
      })
    );
  }

  // Note: Volume updates are typically handled by real-time events
  // This is for manual/scheduled volume recalculation
  if (updateVolume) {
    tasks.push(
      volumeAggregator.getVolumeStats(mintAddress).then((stats) => {
        logger.debug(`Volume stats retrieved for ${mintAddress}`, {
          volume24h: stats.totalVolumeUsd,
        });
      })
    );
  }

  await Promise.all(tasks);

  logger.debug(`Token update completed for ${mintAddress}`, { jobId: job.id });
}

/**
 * Start the token update worker
 */
export function startTokenUpdateWorker(concurrency: number = 5): Worker<TokenUpdateJob> {
  if (worker) {
    return worker;
  }

  worker = new Worker<TokenUpdateJob>(
    QUEUE_NAMES.TOKEN_UPDATE,
    processTokenUpdate,
    {
      connection,
      concurrency,
      limiter: {
        max: 10,
        duration: 1000, // 10 jobs per second max
      },
    }
  );

  worker.on('completed', (job) => {
    logger.debug(`Token update job ${job.id} completed`);
  });

  worker.on('failed', (job, error) => {
    logger.error(`Token update job ${job?.id} failed`, {
      error: error.message,
      mintAddress: job?.data.mintAddress,
    });
  });

  worker.on('error', (error) => {
    logger.error('Token update worker error', { error: error.message });
  });

  logger.info('Token update worker started', { concurrency });

  return worker;
}

/**
 * Stop the token update worker
 */
export async function stopTokenUpdateWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info('Token update worker stopped');
  }
}

/**
 * Schedule a token update
 */
export async function scheduleTokenUpdate(
  mintAddress: string,
  options?: {
    priority?: Priority;
    updatePrice?: boolean;
    updateHolders?: boolean;
    updateVolume?: boolean;
  }
): Promise<Job<TokenUpdateJob>> {
  const priority = options?.priority || PRIORITIES.NORMAL;
  return addJob<TokenUpdateJob>(
    QUEUE_NAMES.TOKEN_UPDATE,
    'update',
    {
      mintAddress,
      priority,
      updatePrice: options?.updatePrice,
      updateHolders: options?.updateHolders,
      updateVolume: options?.updateVolume,
    },
    priority
  );
}

/**
 * Schedule bulk token updates
 */
export async function scheduleBulkTokenUpdates(
  mintAddresses: string[],
  priority: Priority = PRIORITIES.NORMAL
): Promise<void> {
  const { addBulkJobs } = await import('../QueueManager.js');

  const jobs = mintAddresses.map((mintAddress) => ({
    name: 'update',
    data: {
      mintAddress,
      priority,
      updatePrice: true,
    } as TokenUpdateJob,
    priority,
  }));

  await addBulkJobs(QUEUE_NAMES.TOKEN_UPDATE, jobs);
}

export { worker as tokenUpdateWorker };
