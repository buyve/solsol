import dotenv from 'dotenv';

dotenv.config();

export const config = {
  // Application
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  logLevel: process.env.LOG_LEVEL || 'info',

  // Mode flags
  dryRun: process.env.DRY_RUN === 'true',
  mockMode: process.env.MOCK_MODE === 'true',

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

/**
 * Check if running in dry-run mode (structure validation only)
 */
export function isDryRunMode(): boolean {
  return config.dryRun;
}

/**
 * Check if running in mock mode (simulated data)
 */
export function isMockMode(): boolean {
  return config.mockMode;
}

/**
 * Check if external services are required
 */
export function requiresExternalServices(): boolean {
  return !config.dryRun && !config.mockMode && config.nodeEnv === 'production';
}

// Validate required environment variables
export function validateConfig(): boolean {
  const requiredEnvVars = [
    'SHYFT_API_KEY',
    'SHYFT_GRPC_TOKEN',
  ];

  const missing = requiredEnvVars.filter(key => !process.env[key]);

  // In dry-run or mock mode, don't require API keys
  if (config.dryRun || config.mockMode) {
    if (missing.length > 0) {
      console.info(`Info: Running in ${config.dryRun ? 'dry-run' : 'mock'} mode - API keys not required`);
    }
    return true;
  }

  if (missing.length > 0 && config.nodeEnv === 'production') {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  if (missing.length > 0) {
    console.warn(`Warning: Missing environment variables: ${missing.join(', ')}`);
    console.warn('Hint: Set DRY_RUN=true or MOCK_MODE=true to run without API keys');
    return false;
  }

  return true;
}

export default config;
