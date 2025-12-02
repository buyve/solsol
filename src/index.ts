import { config, validateConfig } from './config/index.js';
import { initDatabase, closeDatabase } from './config/database.js';
import { initRedis, closeRedis } from './config/redis.js';
import { logger } from './utils/logger.js';

async function main(): Promise<void> {
  logger.info('Starting Solana Memecoin Data Collection System...');
  logger.info(`Environment: ${config.nodeEnv}`);

  // Validate configuration
  validateConfig();

  try {
    // Initialize database connections
    await initDatabase();
    await initRedis();

    logger.info('All connections established successfully');
    logger.info('System is ready');

    // Keep the process running
    // TODO: Start collectors, workers, and API server here

  } catch (error) {
    logger.error('Failed to start system', error);
    await shutdown(1);
  }
}

async function shutdown(exitCode: number = 0): Promise<void> {
  logger.info('Shutting down...');

  try {
    await closeRedis();
    await closeDatabase();
    logger.info('Shutdown complete');
  } catch (error) {
    logger.error('Error during shutdown', error);
  }

  process.exit(exitCode);
}

// Handle graceful shutdown
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// Handle unhandled errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', error);
  shutdown(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', reason);
  shutdown(1);
});

// Start the application
main().catch((error) => {
  logger.error('Fatal error', error);
  process.exit(1);
});
