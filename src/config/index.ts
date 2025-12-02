import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: resolve(__dirname, '../../.env') });

export const config = {
  // Application
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  logLevel: process.env.LOG_LEVEL || 'info',

  // Database
  database: {
    url: process.env.DATABASE_URL || 'postgresql://solsol:solsol_password@localhost:5432/solsol',
  },

  // Redis
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  // Shyft API
  shyft: {
    apiKey: process.env.SHYFT_API_KEY || '',
    grpcEndpoint: process.env.SHYFT_GRPC_ENDPOINT || '',
    grpcToken: process.env.SHYFT_GRPC_TOKEN || '',
  },

  // Solana
  solana: {
    rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  },

  // Update intervals (milliseconds)
  intervals: {
    price: {
      hot: 5_000,
      active: 30_000,
      inactive: 300_000,
    },
    holders: {
      new: 60_000,
      early: 300_000,
      active: 1_800_000,
      mature: 3_600_000,
    },
    solUsd: 10_000,
  },

  // Cache TTL (seconds)
  cacheTTL: {
    price: 30,
    tokenInfo: 3600,
    poolInfo: 300,
    solUsd: 10,
    holdersTop20: 60,
  },
} as const;

export type Config = typeof config;

export function validateConfig(): void {
  const required = [
    { key: 'SHYFT_API_KEY', value: config.shyft.apiKey },
  ];

  const missing = required.filter(({ value }) => !value);

  if (missing.length > 0 && config.nodeEnv === 'production') {
    throw new Error(
      `Missing required environment variables: ${missing.map(({ key }) => key).join(', ')}`
    );
  }

  if (missing.length > 0) {
    console.warn(
      `Warning: Missing environment variables: ${missing.map(({ key }) => key).join(', ')}`
    );
  }
}
