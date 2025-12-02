import express, { Express, Request, Response } from 'express';
import { Server } from 'http';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { getAllQueueStats } from '../services/queue/QueueManager.js';
import { transactionStreamer } from '../services/collectors/TransactionStreamer.js';
import { poolMonitor } from '../services/collectors/PoolMonitor.js';
import { grpcClient, shyftClient } from '../services/external/index.js';
import { dataRouter } from './data.js';

let app: Express | null = null;
let server: Server | null = null;

/**
 * Start health/status API server
 */
export async function startHealthApi(): Promise<void> {
  if (server) {
    logger.warn('Health API already running');
    return;
  }

  app = express();
  app.use(express.json());

  // Mount data API router
  app.use('/api', dataRouter);

  // Health check endpoint
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  // Detailed status endpoint
  app.get('/status', async (_req: Request, res: Response) => {
    try {
      const queueStats = await getAllQueueStats();
      const streamerStats = transactionStreamer.getStats();
      const monitorStats = poolMonitor.getStats();

      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        mode: {
          dryRun: config.dryRun,
          mockMode: config.mockMode,
          nodeEnv: config.nodeEnv,
        },
        services: {
          transactionStreamer: streamerStats,
          poolMonitor: monitorStats,
          grpc: grpcClient.getStatus(),
          shyft: { configured: shyftClient.isConfigured() },
        },
        queues: queueStats,
      });
    } catch (error) {
      res.status(500).json({
        status: 'error',
        error: (error as Error).message,
      });
    }
  });

  // Queue stats endpoint
  app.get('/queues', async (_req: Request, res: Response) => {
    try {
      const stats = await getAllQueueStats();
      res.json({ queues: stats });
    } catch (error) {
      res.status(500).json({
        status: 'error',
        error: (error as Error).message,
      });
    }
  });

  // Ready check (for k8s probes)
  app.get('/ready', async (_req: Request, res: Response) => {
    // Check if essential services are running
    const streamerStats = transactionStreamer.getStats();
    const monitorStatus = poolMonitor.getMonitoringStatus();

    // In dry-run mode, always ready
    if (config.dryRun) {
      res.json({ ready: true, mode: 'dry-run' });
      return;
    }

    // In mock mode, check if mock services are running
    if (config.mockMode) {
      res.json({ ready: true, mode: 'mock' });
      return;
    }

    // Build readiness assessment
    const reasons: string[] = [];
    let isReady = true;

    // Check if transaction streamer is running when expected
    if (!streamerStats.isRunning && grpcClient.isConfigured()) {
      reasons.push('TransactionStreamer not running (gRPC configured but inactive)');
      isReady = false;
    }

    // Check pool monitor health - use detailed status
    if (monitorStatus.mode !== 'disabled') {
      if (!monitorStatus.isHealthy) {
        reasons.push(`PoolMonitor unhealthy (mode: ${monitorStatus.mode}, errors: ${monitorStatus.errorCount})`);
        isReady = false;
      }

      // Check if monitoring is effectively disabled despite being configured
      if (poolMonitor.isEffectivelyDisabled() &&
          (shyftClient.isConfigured() || grpcClient.isConfigured())) {
        reasons.push('Monitoring configured but effectively disabled');
        isReady = false;
      }
    }

    // If neither service is running and at least one API key is configured, not ready
    if (!streamerStats.isRunning && monitorStatus.mode === 'disabled') {
      if (grpcClient.isConfigured() || shyftClient.isConfigured()) {
        reasons.push('No monitoring services active despite API keys being configured');
        isReady = false;
      }
    }

    // If no API keys configured, we're in limited mode - still consider ready
    // but indicate limited functionality
    const hasApiKeys = grpcClient.isConfigured() || shyftClient.isConfigured();

    if (isReady) {
      res.json({
        ready: true,
        mode: hasApiKeys ? 'full' : 'limited',
        services: {
          transactionStreamer: streamerStats.isRunning,
          poolMonitor: {
            mode: monitorStatus.mode,
            healthy: monitorStatus.isHealthy,
            pools: monitorStatus.poolCount,
          },
        },
      });
    } else {
      res.status(503).json({
        ready: false,
        reasons,
        services: {
          transactionStreamer: streamerStats.isRunning,
          poolMonitor: {
            mode: monitorStatus.mode,
            healthy: monitorStatus.isHealthy,
            pools: monitorStatus.poolCount,
            details: monitorStatus.details,
          },
        },
      });
    }
  });

  // Live check (for k8s probes)
  app.get('/live', (_req: Request, res: Response) => {
    res.json({ live: true });
  });

  return new Promise((resolve) => {
    server = app!.listen(config.port, () => {
      logger.info(`Health API listening on port ${config.port}`);
      resolve();
    });
  });
}

/**
 * Stop health API server
 */
export async function stopHealthApi(): Promise<void> {
  if (server) {
    return new Promise((resolve, reject) => {
      server!.close((err) => {
        if (err) {
          reject(err);
        } else {
          server = null;
          app = null;
          logger.info('Health API stopped');
          resolve();
        }
      });
    });
  }
}

export { app, server };
