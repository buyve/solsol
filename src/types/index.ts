// Token types
export * from './token.js';

// Pool types
export * from './pool.js';

// Holder types
export * from './holder.js';

// Transaction types
export * from './transaction.js';

// Common types
export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: Date;
}

// Update intervals configuration
export const UPDATE_INTERVALS = {
  PRICE: {
    HOT: 5_000,        // Top 100 tokens: 5 seconds
    ACTIVE: 30_000,    // Active tokens: 30 seconds
    INACTIVE: 300_000, // Inactive tokens: 5 minutes
  },
  HOLDERS: {
    NEW: 60_000,           // New (within 1 hour): 1 minute
    EARLY: 300_000,        // Early (within 24 hours): 5 minutes
    ACTIVE: 1_800_000,     // Active (< 1000 holders): 30 minutes
    MATURE: 3_600_000,     // Mature (>= 1000 holders): 1 hour
  },
  POOLS: {
    REALTIME: 0,       // Realtime (gRPC subscription)
  },
  SOL_USD: 10_000,     // 10 seconds
} as const;

// Cache TTL configuration
export const CACHE_TTL = {
  PRICE: 30,           // 30 seconds
  TOKEN_INFO: 3600,    // 1 hour
  POOL_INFO: 300,      // 5 minutes
  SOL_USD: 10,         // 10 seconds
  HOLDERS_TOP20: 60,   // 1 minute (for new tokens)
} as const;
