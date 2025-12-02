import { config, validateConfig, isDryRunMode, isMockMode } from './config/index.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { connectRedis, disconnectRedis } from './config/redis.js';
import { logger } from './utils/logger.js';
import { shyftClient, grpcClient } from './services/external/index.js';
import { startTokenUpdateWorker, stopTokenUpdateWorker } from './services/queue/workers/TokenUpdateWorker.js';
import { startPriceFetchWorker, stopPriceFetchWorker } from './services/queue/workers/PriceFetchWorker.js';
import { startHolderScanWorker, stopHolderScanWorker } from './services/queue/workers/HolderScanWorker.js';
import { startVolumeAggregateWorker, stopVolumeAggregateWorker } from './services/queue/workers/VolumeAggregateWorker.js';
import { startCleanupWorker, stopCleanupWorker } from './services/queue/workers/CleanupWorker.js';
import { transactionStreamer, type ParsedTransaction } from './services/collectors/TransactionStreamer.js';
import { poolMonitor, type PoolUpdate } from './services/collectors/PoolMonitor.js';
import { closeAllQueues, addJob, QUEUE_NAMES, PRIORITIES } from './services/queue/QueueManager.js';
import { startHealthApi, stopHealthApi } from './api/health.js';
import { MockTransactionStreamer } from './services/mock/MockTransactionStreamer.js';
import { volumeAggregator, type TradeRecord } from './services/metrics/VolumeAggregator.js';
import { shyftPriceCalculator } from './services/pricing/ShyftPriceCalculator.js';
import { tokenScheduler } from './services/scheduler/TokenScheduler.js';
import { TransactionRepository } from './services/repositories/TransactionRepository.js';
import { TokenRepository } from './services/repositories/TokenRepository.js';

// Repository instances for pipeline
const transactionRepository = new TransactionRepository();
const tokenRepository = new TokenRepository();

// Track running services for cleanup
let mockStreamer: MockTransactionStreamer | null = null;

// Suppress unused variable warnings
void shyftClient;
void grpcClient;

async function bootstrap(): Promise<void> {
  logger.info('Starting Solana Memecoin Data Collection System...', {
    dryRun: isDryRunMode(),
    mock: isMockMode(),
  });

  // Validate configuration
  const configValid = validateConfig();

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

    // Start Health API for monitoring
    await startHealthApi();

    // Dry-run mode: just verify structure without starting services
    if (isDryRunMode()) {
      logger.info('DRY-RUN mode: Validating service initialization...');
      await validateServiceStructure();
      logger.info('DRY-RUN mode: All services validated successfully');
      logger.info(`Server running in ${config.nodeEnv} mode (dry-run)`);
      return;
    }

    // Mock mode: start with mock data for testing
    if (isMockMode()) {
      logger.info('MOCK mode: Starting with simulated data...');
      await startMockServices();
      logger.info(`Server running in ${config.nodeEnv} mode (mock)`);
      return;
    }

    // Production mode: require API keys
    if (!serviceStatus.shyft || !serviceStatus.grpc) {
      if (config.nodeEnv === 'production') {
        throw new Error('External services not configured in production mode');
      }
      logger.warn('External services not configured - running in limited mode', {
        missingShyft: !serviceStatus.shyft,
        missingGrpc: !serviceStatus.grpc,
        hint: 'Set DRY_RUN=true or MOCK_MODE=true to test without API keys',
      });
      // Start only what we can (queue workers, polling-based monitoring)
      await startLimitedServices();
    } else {
      // Full services with API keys
      await startFullServices();
    }

    logger.info(`Server running in ${config.nodeEnv} mode`);

  } catch (error) {
    logger.error('Failed to start application', { error });
    await shutdown();
    process.exit(1);
  }
}

/**
 * Validate service structure without starting them (dry-run)
 */
async function validateServiceStructure(): Promise<void> {
  logger.debug('Validating TransactionStreamer...');
  const streamerStats = transactionStreamer.getStats();
  logger.debug('TransactionStreamer config valid', { platforms: streamerStats.platforms });

  logger.debug('Validating PoolMonitor...');
  const monitorStats = poolMonitor.getStats();
  logger.debug('PoolMonitor config valid', { isRunning: monitorStats.isRunning });

  logger.debug('Validating TokenUpdateWorker...');
  // Just import check - don't start
  logger.debug('TokenUpdateWorker module valid');

  logger.info('All service structures validated');
}

/**
 * Start all queue workers
 */
function startAllWorkers(mode: 'mock' | 'limited' | 'full'): void {
  const concurrency = mode === 'full' ? { token: 5, price: 3, holder: 2, volume: 3, cleanup: 1 }
    : mode === 'limited' ? { token: 3, price: 2, holder: 1, volume: 2, cleanup: 1 }
    : { token: 2, price: 1, holder: 1, volume: 1, cleanup: 1 };

  startTokenUpdateWorker(concurrency.token);
  startPriceFetchWorker(concurrency.price);
  startHolderScanWorker(concurrency.holder);
  startVolumeAggregateWorker(concurrency.volume);
  startCleanupWorker(concurrency.cleanup);

  logger.info('All queue workers started', { mode, concurrency });
}

/**
 * Stop all queue workers
 */
async function stopAllWorkers(): Promise<void> {
  await Promise.all([
    stopTokenUpdateWorker(),
    stopPriceFetchWorker(),
    stopHolderScanWorker(),
    stopVolumeAggregateWorker(),
    stopCleanupWorker(),
  ]);
  logger.info('All queue workers stopped');
}

/**
 * Start mock services for testing without API keys
 */
async function startMockServices(): Promise<void> {
  // Start queue workers (they work with mock data)
  startAllWorkers('mock');
  logger.info('Queue workers started (mock mode)');

  // Start mock transaction streamer
  mockStreamer = new MockTransactionStreamer({
    intervalMs: 3000, // Generate mock tx every 3 seconds
    platforms: ['pump.fun', 'letsbonk'],
  });

  mockStreamer.on('transaction', (tx: ParsedTransaction) => {
    logger.debug('Mock transaction received', {
      platform: tx.platform,
      type: tx.type,
      mint: tx.tokenMint?.substring(0, 10) + '...',
    });
  });

  mockStreamer.on('newToken', (tx: ParsedTransaction) => {
    logger.info('Mock new token detected', {
      platform: tx.platform,
      mint: tx.tokenMint,
    });
  });

  await mockStreamer.start();
  logger.info('MockTransactionStreamer started');

  // Start pool monitor in polling mode (no gRPC needed)
  await poolMonitor.start();
  logger.info('PoolMonitor started (polling mode)');
}

/**
 * Start limited services (without external API keys)
 */
async function startLimitedServices(): Promise<void> {
  // Start all queue workers
  startAllWorkers('limited');
  logger.info('Queue workers started (limited mode)');

  // Start pool monitor (will use polling mode)
  await poolMonitor.start();
  logger.info('PoolMonitor started (polling mode - no gRPC)');

  logger.warn('Transaction streaming disabled - no gRPC token configured');
}

/**
 * Start all services with API keys configured
 */
async function startFullServices(): Promise<void> {
  // Start all queue workers
  startAllWorkers('full');
  logger.info('Queue workers started (full mode)');

  // Start token scheduler for periodic updates
  tokenScheduler.start();
  logger.info('TokenScheduler started');

  // Start volume aggregator cleanup job
  volumeAggregator.startCleanupJob();
  logger.info('VolumeAggregator cleanup job started');

  // Setup transaction streamer event handlers with real pipeline
  setupTransactionPipeline();

  // Setup pool monitor event handlers
  setupPoolMonitorPipeline();

  // Start transaction streamer (gRPC-based, non-blocking)
  await transactionStreamer.start();
  logger.info('TransactionStreamer started');

  // Start pool monitor (non-blocking)
  await poolMonitor.start();
  logger.info('PoolMonitor started');
}

/**
 * Setup transaction processing pipeline
 * Connects gRPC events to queues, DB, and volume tracking
 */
function setupTransactionPipeline(): void {
  // Handle new token creation
  transactionStreamer.on('newToken', async (tx: ParsedTransaction) => {
    logger.info('New token detected', {
      platform: tx.platform,
      mint: tx.tokenMint,
      signature: tx.signature.substring(0, 20) + '...',
    });

    if (!tx.tokenMint) return;

    try {
      // Create token record and add to monitoring
      const tokenId = await tokenRepository.upsertToken({
        mintAddress: tx.tokenMint,
        launchPlatform: tx.platform,
        isActive: true,
      });

      if (tokenId) {
        // Add to monitored_tokens for scheduled updates
        await tokenScheduler.addTokenToMonitoring(tx.tokenMint, 3, 30); // High priority, 30s interval
      }

      // Queue token for metadata fetch and initial processing
      await addJob(
        QUEUE_NAMES.TOKEN_UPDATE,
        'new-token',
        {
          mintAddress: tx.tokenMint,
          priority: PRIORITIES.CRITICAL,
          updatePrice: true,
          updateHolders: true,
          updateVolume: false,
        },
        PRIORITIES.CRITICAL
      );

      // Add pool to monitoring for this new token
      await poolMonitor.addPoolsByToken(tx.tokenMint);

      logger.debug('New token queued for processing', { mint: tx.tokenMint });
    } catch (error) {
      logger.error('Failed to queue new token', { mint: tx.tokenMint, error });
    }
  });

  // Handle swap transactions - record volume
  transactionStreamer.on('swap', async (tx: ParsedTransaction) => {
    if (!tx.tokenMint || !tx.success) return;

    try {
      // Get current SOL/USD rate for volume calculation
      const solUsdRate = await shyftPriceCalculator.getSolUsdRate();

      // Calculate amounts from ACTUAL executed amounts (from balance changes)
      // amountSol is in lamports (1 SOL = 1e9 lamports)
      const amountSol = tx.amountSol ? Number(tx.amountSol) / 1e9 : 0;
      const amountUsd = amountSol * solUsdRate;

      // Calculate token amount with proper decimals
      // amountToken is raw (includes decimals), tokenDecimals tells us how to format
      const tokenDecimals = tx.tokenDecimals ?? 6; // Default to 6 for most memecoins
      const amountTokenFormatted = tx.amountToken
        ? Number(tx.amountToken) / Math.pow(10, tokenDecimals)
        : 0;

      // Calculate price per token (USD per token)
      // Only calculate if we have valid token amount to avoid division by zero
      const pricePerToken = amountTokenFormatted > 0 ? amountUsd / amountTokenFormatted : 0;

      // Record trade for volume aggregation (Redis)
      const trade: TradeRecord = {
        mintAddress: tx.tokenMint,
        amountSol,
        amountUsd,
        type: tx.type === 'buy' ? 'buy' : 'sell',
        timestamp: Date.now(),
        txSignature: tx.signature,
      };

      await volumeAggregator.recordTrade(trade);

      // Save transaction to database
      const tokenId = await tokenRepository.getTokenIdByMint(tx.tokenMint);
      if (tokenId) {
        await transactionRepository.insertTransaction({
          signature: tx.signature,
          tokenId,
          txType: tx.type,
          walletAddress: tx.walletAddress,
          amountSol,
          amountToken: amountTokenFormatted.toString(),
          priceAtTx: pricePerToken,
          blockTime: tx.blockTime ? new Date(tx.blockTime * 1000) : undefined,
          slot: tx.slot,
        });
      }

      logger.debug('Swap recorded', {
        platform: tx.platform,
        mint: tx.tokenMint?.substring(0, 10) + '...',
        type: tx.type,
        amountSol: amountSol.toFixed(4),
        amountToken: amountTokenFormatted.toFixed(2),
        priceUsd: pricePerToken.toFixed(8),
      });
    } catch (error) {
      logger.error('Failed to record swap', { mint: tx.tokenMint, error });
    }
  });

  // Handle liquidity events
  transactionStreamer.on('liquidity', async (tx: ParsedTransaction) => {
    if (!tx.tokenMint || !tx.poolAddress) return;

    logger.debug('Liquidity event detected', {
      platform: tx.platform,
      type: tx.type,
      pool: tx.poolAddress?.substring(0, 10) + '...',
    });

    // Update pool monitoring if liquidity added
    if (tx.type === 'add_liquidity' && tx.poolAddress) {
      await poolMonitor.addPool(tx.poolAddress, tx.tokenMint);
    }
  });

  // Handle errors
  transactionStreamer.on('error', (error: Error) => {
    logger.error('TransactionStreamer error', { error: error.message });
  });
}

/**
 * Setup pool monitor event handlers
 */
function setupPoolMonitorPipeline(): void {
  poolMonitor.on('poolUpdate', async (update: PoolUpdate) => {
    logger.debug('Pool update received', {
      pool: update.poolAddress.substring(0, 10) + '...',
      priceChange: update.priceChange?.toFixed(2) + '%',
      liquidityChange: update.liquidityChange?.toFixed(2) + '%',
    });

    // Queue price update job if significant change
    if (Math.abs(update.priceChange || 0) > 1) {
      try {
        await addJob(
          QUEUE_NAMES.PRICE_FETCH,
          'pool-price-update',
          {
            mintAddresses: [update.tokenMint],
            priority: PRIORITIES.HIGH,
          },
          PRIORITIES.HIGH
        );
      } catch (error) {
        logger.error('Failed to queue price update', { pool: update.poolAddress, error });
      }
    }
  });
}

async function shutdown(): Promise<void> {
  logger.info('Shutting down...');

  try {
    // Stop mock streamer if running
    if (mockStreamer) {
      await mockStreamer.stop();
    }

    // Stop transaction streamer
    await transactionStreamer.stop();

    // Stop pool monitor
    await poolMonitor.stop();

    // Stop volume aggregator cleanup job
    volumeAggregator.stopCleanupJob();

    // Stop token scheduler
    tokenScheduler.stop();

    // Stop all workers
    await stopAllWorkers();

    // Close all queues
    await closeAllQueues();

    // Stop health API
    await stopHealthApi();

    // Disconnect from databases
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
