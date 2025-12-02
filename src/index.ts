import { config, validateConfig } from './config/index.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { connectRedis, disconnectRedis } from './config/redis.js';
import { logger } from './utils/logger.js';
import { shyftClient, grpcClient, jupiterPriceClient } from './services/external/index.js';

async function bootstrap(): Promise<void> {
  logger.info('Starting Solana Memecoin Data Collection System...');

  // Validate configuration
  validateConfig();

  // Connect to databases
  try {
    await connectDatabase();
    await connectRedis();

    logger.info('All connections established successfully');

    // Check external service configurations
    const serviceStatus = {
      shyft: shyftClient.isConfigured(),
      grpc: grpcClient.isConfigured(),
      jupiter: true, // Jupiter doesn't require API key
    };

    logger.info('External service status', serviceStatus);

    if (serviceStatus.shyft && serviceStatus.grpc) {
      logger.info('All external services configured - ready for data collection');
    } else {
      logger.warn('Some external services not configured', {
        missingShyft: !serviceStatus.shyft,
        missingGrpc: !serviceStatus.grpc,
      });
    }

    logger.info(`Server running in ${config.nodeEnv} mode`);

    // TODO: Initialize services
    // - BullMQ Workers
    // - API Server (if needed)
    // - Transaction Streamer (Phase 3)

  } catch (error) {
    logger.error('Failed to start application', { error });
    await shutdown();
    process.exit(1);
  }
}

async function shutdown(): Promise<void> {
  logger.info('Shutting down...');

  try {
    await disconnectRedis();
    await disconnectDatabase();
    logger.info('Graceful shutdown completed');
  } catch (error) {
    logger.error('Error during shutdown', { error });
  }
}

// Graceful shutdown handlers
process.on('SIGINT', async () => {
  logger.info('Received SIGINT signal');
  await shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM signal');
  await shutdown();
  process.exit(0);
});

process.on('uncaughtException', async (error) => {
  logger.error('Uncaught exception', { error: error.message, stack: error.stack });
  await shutdown();
  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  logger.error('Unhandled rejection', { reason });
  await shutdown();
  process.exit(1);
});

// Start the application
bootstrap();
