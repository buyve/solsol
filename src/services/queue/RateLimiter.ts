import { logger } from '../../utils/logger.js';
import { getRedisClient } from '../../config/redis.js';

export interface RateLimiterConfig {
  name: string;
  maxRequests: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetIn: number;
  total: number;
}

// Predefined rate limiters
export const RATE_LIMITERS = {
  JUPITER: {
    name: 'jupiter',
    maxRequests: 60,
    windowMs: 60000, // 60 requests per minute
  },
  SHYFT_REST: {
    name: 'shyft-rest',
    maxRequests: 100,
    windowMs: 60000, // 100 requests per minute
  },
  SHYFT_GRPC: {
    name: 'shyft-grpc',
    maxRequests: 1000,
    windowMs: 60000, // Higher limit for gRPC
  },
  RPC: {
    name: 'solana-rpc',
    maxRequests: 40,
    windowMs: 10000, // 40 requests per 10 seconds
  },
} as const;

export class RateLimiter {
  private config: RateLimiterConfig;
  private keyPrefix: string;

  constructor(config: RateLimiterConfig) {
    this.config = config;
    this.keyPrefix = `ratelimit:${config.name}`;
  }

  /**
   * Check if request is allowed (sliding window algorithm)
   */
  async checkLimit(): Promise<RateLimitResult> {
    const client = getRedisClient();
    const now = Date.now();
    const windowStart = now - this.config.windowMs;
    const key = `${this.keyPrefix}:requests`;

    try {
      // Use Redis transaction for atomic operations
      const multi = client.multi();

      // Remove old entries outside the window
      multi.zRemRangeByScore(key, '-inf', windowStart);

      // Count current requests in window
      multi.zCard(key);

      // Add current request
      multi.zAdd(key, { score: now, value: `${now}:${Math.random()}` });

      // Set expiry on the key
      multi.expire(key, Math.ceil(this.config.windowMs / 1000) + 1);

      const results = await multi.exec();

      // zCard result is at index 1
      const currentCount = (results?.[1] as number) || 0;
      const allowed = currentCount < this.config.maxRequests;
      const remaining = Math.max(0, this.config.maxRequests - currentCount - 1);

      // Calculate reset time (when oldest request will expire)
      let resetIn = this.config.windowMs;
      if (currentCount > 0) {
        const oldestEntries = await client.zRange(key, 0, 0);
        if (oldestEntries.length > 0) {
          const oldestTime = parseInt(oldestEntries[0].split(':')[0]);
          resetIn = Math.max(0, oldestTime + this.config.windowMs - now);
        }
      }

      if (!allowed) {
        logger.warn(`Rate limit exceeded for ${this.config.name}`, {
          current: currentCount,
          max: this.config.maxRequests,
          resetIn,
        });
      }

      return {
        allowed,
        remaining,
        resetIn,
        total: this.config.maxRequests,
      };
    } catch (error) {
      logger.error('Rate limiter error', {
        name: this.config.name,
        error: (error as Error).message,
      });

      // Allow on error to not block operations
      return {
        allowed: true,
        remaining: this.config.maxRequests,
        resetIn: 0,
        total: this.config.maxRequests,
      };
    }
  }

  /**
   * Wait until rate limit allows the request
   */
  async waitForLimit(): Promise<void> {
    const maxRetries = 10;
    let retries = 0;

    while (retries < maxRetries) {
      const result = await this.checkLimit();

      if (result.allowed) {
        return;
      }

      const waitTime = Math.min(result.resetIn + 100, 5000);
      logger.debug(`Waiting for rate limit: ${waitTime}ms`, {
        name: this.config.name,
      });

      await this.sleep(waitTime);
      retries++;
    }

    throw new Error(`Rate limit timeout for ${this.config.name}`);
  }

  /**
   * Execute a function with rate limiting
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    await this.waitForLimit();
    return fn();
  }

  /**
   * Get current rate limit status
   */
  async getStatus(): Promise<RateLimitResult> {
    const client = getRedisClient();
    const now = Date.now();
    const windowStart = now - this.config.windowMs;
    const key = `${this.keyPrefix}:requests`;

    try {
      // Clean old entries and count
      await client.zRemRangeByScore(key, '-inf', windowStart);
      const currentCount = await client.zCard(key);

      const remaining = Math.max(0, this.config.maxRequests - currentCount);

      return {
        allowed: currentCount < this.config.maxRequests,
        remaining,
        resetIn: this.config.windowMs,
        total: this.config.maxRequests,
      };
    } catch (error) {
      return {
        allowed: true,
        remaining: this.config.maxRequests,
        resetIn: 0,
        total: this.config.maxRequests,
      };
    }
  }

  /**
   * Reset rate limiter
   */
  async reset(): Promise<void> {
    const client = getRedisClient();
    const key = `${this.keyPrefix}:requests`;

    try {
      await client.del(key);
      logger.info(`Rate limiter ${this.config.name} reset`);
    } catch (error) {
      logger.error('Failed to reset rate limiter', {
        name: this.config.name,
        error: (error as Error).message,
      });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Pre-configured rate limiters
export const jupiterLimiter = new RateLimiter(RATE_LIMITERS.JUPITER);
export const shyftRestLimiter = new RateLimiter(RATE_LIMITERS.SHYFT_REST);
export const shyftGrpcLimiter = new RateLimiter(RATE_LIMITERS.SHYFT_GRPC);
export const rpcLimiter = new RateLimiter(RATE_LIMITERS.RPC);

/**
 * Create a custom rate limiter
 */
export function createRateLimiter(
  name: string,
  maxRequests: number,
  windowMs: number
): RateLimiter {
  return new RateLimiter({ name, maxRequests, windowMs });
}

/**
 * Get all rate limiter statuses
 */
export async function getAllRateLimitStatuses(): Promise<
  Array<{ name: string; status: RateLimitResult }>
> {
  const limiters = [
    { name: 'jupiter', limiter: jupiterLimiter },
    { name: 'shyft-rest', limiter: shyftRestLimiter },
    { name: 'shyft-grpc', limiter: shyftGrpcLimiter },
    { name: 'rpc', limiter: rpcLimiter },
  ];

  const statuses = await Promise.all(
    limiters.map(async ({ name, limiter }) => ({
      name,
      status: await limiter.getStatus(),
    }))
  );

  return statuses;
}

export default RateLimiter;
