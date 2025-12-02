import { createClient, RedisClientType } from 'redis';
import { config } from './index.js';
import { logger } from '../utils/logger.js';

let redisClient: RedisClientType | null = null;

export function getRedisClient(): RedisClientType {
  if (!redisClient) {
    redisClient = createClient({
      url: config.redis.url,
    });

    redisClient.on('error', (err) => {
      logger.error('Redis client error', err);
    });

    redisClient.on('connect', () => {
      logger.debug('Redis client connecting');
    });

    redisClient.on('ready', () => {
      logger.info('Redis client ready');
    });

    redisClient.on('reconnecting', () => {
      logger.warn('Redis client reconnecting');
    });
  }
  return redisClient;
}

export async function initRedis(): Promise<void> {
  const client = getRedisClient();

  try {
    await client.connect();
    const pong = await client.ping();
    logger.info(`Redis connected: ${pong}`);
  } catch (error) {
    logger.error('Failed to connect to Redis', error);
    throw error;
  }
}

export async function closeRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    logger.info('Redis connection closed');
  }
}

// Price cache operations
export async function setPrice(
  mintAddress: string,
  data: { priceSol: number; priceUsd: number; solUsd: number; updatedAt: number }
): Promise<void> {
  const client = getRedisClient();
  const key = `price:${mintAddress}`;
  await client.setEx(key, config.cacheTTL.price, JSON.stringify(data));
}

export async function getPrice(
  mintAddress: string
): Promise<{ priceSol: number; priceUsd: number; solUsd: number; updatedAt: number } | null> {
  const client = getRedisClient();
  const key = `price:${mintAddress}`;
  const data = await client.get(key);
  return data ? JSON.parse(data) : null;
}

// SOL/USD rate cache
export async function setSolUsdRate(rate: number): Promise<void> {
  const client = getRedisClient();
  await client.setEx('rate:sol:usd', config.cacheTTL.solUsd, rate.toString());
}

export async function getSolUsdRate(): Promise<number | null> {
  const client = getRedisClient();
  const rate = await client.get('rate:sol:usd');
  return rate ? parseFloat(rate) : null;
}

// Pool cache operations
export async function setPoolInfo(
  poolAddress: string,
  data: { baseReserve: string; quoteReserve: string; liquidityUsd: number }
): Promise<void> {
  const client = getRedisClient();
  const key = `pool:${poolAddress}`;
  await client.setEx(key, config.cacheTTL.poolInfo, JSON.stringify(data));
}

export async function getPoolInfo(
  poolAddress: string
): Promise<{ baseReserve: string; quoteReserve: string; liquidityUsd: number } | null> {
  const client = getRedisClient();
  const key = `pool:${poolAddress}`;
  const data = await client.get(key);
  return data ? JSON.parse(data) : null;
}

// Active pools set
export async function addActivePool(poolAddress: string): Promise<void> {
  const client = getRedisClient();
  await client.sAdd('pools:active', poolAddress);
}

export async function getActivePools(): Promise<string[]> {
  const client = getRedisClient();
  return client.sMembers('pools:active');
}

export async function removeActivePool(poolAddress: string): Promise<void> {
  const client = getRedisClient();
  await client.sRem('pools:active', poolAddress);
}
