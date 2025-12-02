import { Queue, Worker, QueueEvents, Job, ConnectionOptions } from 'bullmq';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';

// Redis connection for BullMQ
const connection: ConnectionOptions = {
  host: new URL(config.redisUrl).hostname,
  port: parseInt(new URL(config.redisUrl).port || '6379'),
};

// Queue names
export const QUEUE_NAMES = {
  TOKEN_UPDATE: 'token-update',
  PRICE_FETCH: 'price-fetch',
  HOLDER_SCAN: 'holder-scan',
  VOLUME_AGGREGATE: 'volume-aggregate',
  CLEANUP: 'cleanup',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

// Job priorities (lower = higher priority)
export const PRIORITIES = {
  CRITICAL: 1,
  HIGH: 2,
  NORMAL: 3,
  LOW: 4,
  BACKGROUND: 5,
} as const;

export type Priority = (typeof PRIORITIES)[keyof typeof PRIORITIES];

// Job types
export interface TokenUpdateJob {
  mintAddress: string;
  priority: Priority;
  updatePrice?: boolean;
  updateHolders?: boolean;
  updateVolume?: boolean;
}

export interface PriceFetchJob {
  mintAddresses: string[];
  priority: Priority;
}

export interface HolderScanJob {
  mintAddress: string;
  priority: Priority;
  takeSnapshot?: boolean;
}

export interface VolumeAggregateJob {
  mintAddress: string;
  priority: Priority;
}

export interface CleanupJob {
  type: 'holders' | 'volume' | 'prices' | 'all';
  retentionDays?: number;
}

// Default job options
const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: {
    type: 'exponential' as const,
    delay: 1000,
  },
  removeOnComplete: {
    age: 3600, // 1 hour
    count: 1000,
  },
  removeOnFail: {
    age: 24 * 3600, // 24 hours
  },
};

// Queue instances
const queues: Map<QueueName, Queue> = new Map();
const queueEvents: Map<QueueName, QueueEvents> = new Map();

/**
 * Get or create a queue
 */
export function getQueue(name: QueueName): Queue {
  let queue = queues.get(name);

  if (!queue) {
    queue = new Queue(name, {
      connection,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });

    queue.on('error', (error) => {
      logger.error(`Queue ${name} error`, { error: error.message });
    });

    queues.set(name, queue);
    logger.info(`Queue ${name} initialized`);
  }

  return queue;
}

/**
 * Get queue events for monitoring
 */
export function getQueueEvents(name: QueueName): QueueEvents {
  let events = queueEvents.get(name);

  if (!events) {
    events = new QueueEvents(name, { connection });

    events.on('completed', ({ jobId }) => {
      logger.debug(`Job ${jobId} completed in queue ${name}`);
    });

    events.on('failed', ({ jobId, failedReason }) => {
      logger.error(`Job ${jobId} failed in queue ${name}`, { reason: failedReason });
    });

    events.on('stalled', ({ jobId }) => {
      logger.warn(`Job ${jobId} stalled in queue ${name}`);
    });

    queueEvents.set(name, events);
  }

  return events;
}

/**
 * Add a job to a queue
 */
export async function addJob<T>(
  queueName: QueueName,
  jobName: string,
  data: T,
  priority: Priority = PRIORITIES.NORMAL
): Promise<Job<T>> {
  const queue = getQueue(queueName);

  const job = await queue.add(jobName, data, {
    priority,
  });

  logger.debug(`Job ${job.id} added to queue ${queueName}`, {
    jobName,
    priority,
  });

  return job;
}

/**
 * Add multiple jobs in bulk
 */
export async function addBulkJobs<T>(
  queueName: QueueName,
  jobs: Array<{ name: string; data: T; priority?: Priority }>
): Promise<Job<T>[]> {
  const queue = getQueue(queueName);

  const bulkJobs = jobs.map((job) => ({
    name: job.name,
    data: job.data,
    opts: { priority: job.priority || PRIORITIES.NORMAL },
  }));

  const addedJobs = await queue.addBulk(bulkJobs);

  logger.debug(`${addedJobs.length} jobs added to queue ${queueName}`);

  return addedJobs;
}

/**
 * Get queue statistics
 */
export async function getQueueStats(queueName: QueueName) {
  const queue = getQueue(queueName);

  const [waiting, active, completed, failed, delayed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
    queue.getDelayedCount(),
  ]);

  return {
    queueName,
    waiting,
    active,
    completed,
    failed,
    delayed,
    total: waiting + active + delayed,
  };
}

/**
 * Get all queue statistics
 */
export async function getAllQueueStats() {
  const stats = await Promise.all(
    Object.values(QUEUE_NAMES).map((name) => getQueueStats(name))
  );

  return stats;
}

/**
 * Pause a queue
 */
export async function pauseQueue(queueName: QueueName): Promise<void> {
  const queue = getQueue(queueName);
  await queue.pause();
  logger.info(`Queue ${queueName} paused`);
}

/**
 * Resume a queue
 */
export async function resumeQueue(queueName: QueueName): Promise<void> {
  const queue = getQueue(queueName);
  await queue.resume();
  logger.info(`Queue ${queueName} resumed`);
}

/**
 * Clean a queue
 */
export async function cleanQueue(
  queueName: QueueName,
  grace: number = 0,
  limit: number = 0,
  type: 'completed' | 'failed' | 'delayed' | 'wait' | 'active' = 'completed'
): Promise<string[]> {
  const queue = getQueue(queueName);
  const removed = await queue.clean(grace, limit, type);
  logger.info(`Cleaned ${removed.length} ${type} jobs from queue ${queueName}`);
  return removed;
}

/**
 * Close all queues
 */
export async function closeAllQueues(): Promise<void> {
  const closePromises: Promise<void>[] = [];

  for (const [name, queue] of queues) {
    closePromises.push(
      queue.close().then(() => {
        logger.info(`Queue ${name} closed`);
      })
    );
  }

  for (const [name, events] of queueEvents) {
    closePromises.push(
      events.close().then(() => {
        logger.debug(`Queue events ${name} closed`);
      })
    );
  }

  await Promise.all(closePromises);

  queues.clear();
  queueEvents.clear();

  logger.info('All queues closed');
}

export { Queue, Worker, Job, connection };
