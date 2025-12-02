import dotenv from 'dotenv';

dotenv.config();

export const config = {
  // Application
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  logLevel: process.env.LOG_LEVEL || 'info',

  // Database
  databaseUrl: process.env.DATABASE_URL || 'postgresql://solsol:solsol_password@localhost:5432/solsol',

  // Redis
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

  // Shyft API
  shyft: {
    apiKey: process.env.SHYFT_API_KEY || '',
    grpcEndpoint: process.env.SHYFT_GRPC_ENDPOINT || 'https://grpc.ams.shyft.to',
    grpcToken: process.env.SHYFT_GRPC_TOKEN || '',
  },

  // Jupiter API
  jupiter: {
    apiUrl: process.env.JUPITER_API_URL || 'https://lite-api.jup.ag/price/v3',
  },

  // Solana RPC
  solana: {
    rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  },

  // Worker Threads
  workers: {
    grpcCount: parseInt(process.env.GRPC_WORKER_COUNT || '2', 10),
  },
} as const;

// Validate required environment variables
export function validateConfig(): void {
  const requiredEnvVars = [
    'SHYFT_API_KEY',
    'SHYFT_GRPC_TOKEN',
  ];

  const missing = requiredEnvVars.filter(key => !process.env[key]);

  if (missing.length > 0 && config.nodeEnv === 'production') {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  if (missing.length > 0) {
    console.warn(`Warning: Missing environment variables: ${missing.join(', ')}`);
  }
}

export default config;
