import { Worker, Job } from 'bullmq';
import { logger } from '../../../utils/logger.js';
import {
  connection,
  QUEUE_NAMES,
  HolderScanJob,
} from '../QueueManager.js';
import { holderScanner, HolderAnalysis } from '../../holders/HolderScanner.js';
import { holderSnapshot } from '../../holders/HolderSnapshot.js';
import { TokenRepository } from '../../repositories/TokenRepository.js';
import { HolderRepository } from '../../repositories/HolderRepository.js';

let worker: Worker<HolderScanJob> | null = null;
const tokenRepository = new TokenRepository();
const holderRepository = new HolderRepository();

/**
 * Process holder scan job
 * Scans holders for a token and persists to database
 */
async function processHolderScan(job: Job<HolderScanJob>): Promise<void> {
  const { mintAddress, priority, takeSnapshot } = job.data;

  logger.debug(`Processing holder scan for ${mintAddress}`, {
    jobId: job.id,
    priority,
    takeSnapshot,
  });

  try {
    // Analyze holders
    const analysis = await holderScanner.analyzeHolders(mintAddress);

    if (!analysis) {
      logger.warn(`No holder data found for ${mintAddress}`);
      return;
    }

    // Get or create token record
    let tokenId = await tokenRepository.getTokenIdByMint(mintAddress);

    if (!tokenId) {
      tokenId = await tokenRepository.upsertToken({
        mintAddress,
        isActive: true,
      });
    }

    if (tokenId) {
      // Save holder snapshot to database
      await holderRepository.insertHolderSnapshot({
        tokenId,
        mintAddress,
        totalHolders: analysis.totalHolders,
        top10Percentage: analysis.top10Percentage,
        top20Percentage: analysis.top20Percentage,
        top50Percentage: analysis.top50Percentage,
        giniCoefficient: analysis.giniCoefficient,
        topHoldersJson: analysis.holders.slice(0, 50),
      });

      // Save top holders individually
      await holderRepository.insertTopHolders(
        tokenId,
        analysis.holders.slice(0, 100)
      );

      logger.debug(`Holder snapshot saved for ${mintAddress}`, {
        totalHolders: analysis.totalHolders,
        top10Pct: analysis.top10Percentage.toFixed(2),
      });

      // Take historical snapshot if requested
      // Note: holderSnapshot.takeSnapshot fetches its own analysis data
      if (takeSnapshot) {
        await holderSnapshot.takeSnapshot(mintAddress);
        logger.debug(`Historical snapshot taken for ${mintAddress}`);
      }
    }
  } catch (error) {
    logger.error(`Failed to scan holders for ${mintAddress}`, {
      error: (error as Error).message,
    });
    throw error;
  }
}

/**
 * Start the holder scan worker
 */
export function startHolderScanWorker(concurrency: number = 2): Worker<HolderScanJob> {
  if (worker) {
    return worker;
  }

  worker = new Worker<HolderScanJob>(
    QUEUE_NAMES.HOLDER_SCAN,
    processHolderScan,
    {
      connection,
      concurrency,
      limiter: {
        max: 5,
        duration: 1000, // 5 jobs per second max (holder scans are expensive)
      },
    }
  );

  worker.on('completed', (job) => {
    logger.debug(`Holder scan job ${job.id} completed`);
  });

  worker.on('failed', (job, error) => {
    logger.error(`Holder scan job ${job?.id} failed`, {
      error: error.message,
      mintAddress: job?.data.mintAddress,
    });
  });

  worker.on('error', (error) => {
    logger.error('Holder scan worker error', { error: error.message });
  });

  logger.info('Holder scan worker started', { concurrency });

  return worker;
}

/**
 * Stop the holder scan worker
 */
export async function stopHolderScanWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info('Holder scan worker stopped');
  }
}

export { worker as holderScanWorker };
