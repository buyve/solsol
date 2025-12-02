import { createClient, RedisClientType } from 'redis';
import { config } from './index.js';
import { logger } from '../utils/logger.js';

export type RedisClient = RedisClientType;

let redisClient: RedisClient | null = null;

export async function connectRedis(): Promise<RedisClient> {
  if (redisClient && redisClient.isOpen) {
    return redisClient;
  }

  redisClient = createClient({
    url: config.redisUrl,
    socket: {
      reconnectStrategy: (retries) => {
        if (retries > 10) {
          logger.error('Redis max reconnection attempts reached');
          return new Error('Max reconnection attempts reached');
        }
        const delay = Math.min(retries * 100, 3000);
        logger.warn(`Redis reconnecting in ${delay}ms`, { attempt: retries });
        return delay;
      },
    },
  });

  redisClient.on('connect', () => {
    logger.info('Redis client connected');
  });

  redisClient.on('error', (err) => {
    logger.error('Redis client error', { error: err.message });
  });

  redisClient.on('reconnecting', () => {
    logger.warn('Redis client reconnecting');
  });

  await redisClient.connect();
  return redisClient;
}

export async function disconnectRedis(): Promise<void> {
  if (redisClient && redisClient.isOpen) {
    await redisClient.quit();
    logger.info('Redis connection closed');
  }
}

export function getRedisClient(): RedisClient {
  if (!redisClient || !redisClient.isOpen) {
    throw new Error('Redis client is not connected. Call connectRedis() first.');
  }
  return redisClient;
}

// Cache helper functions
export const cache = {
  async get<T>(key: string): Promise<T | null> {
    const client = getRedisClient();
    const data = await client.get(key);
    return data ? JSON.parse(data) : null;
  },

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const client = getRedisClient();
    const stringValue = JSON.stringify(value);

    if (ttlSeconds) {
      await client.setEx(key, ttlSeconds, stringValue);
    } else {
      await client.set(key, stringValue);
    }
  },

  async del(key: string): Promise<void> {
    const client = getRedisClient();
    await client.del(key);
  },

  async exists(key: string): Promise<boolean> {
    const client = getRedisClient();
    return (await client.exists(key)) === 1;
  },
};

export default { connectRedis, disconnectRedis, getRedisClient, cache };
