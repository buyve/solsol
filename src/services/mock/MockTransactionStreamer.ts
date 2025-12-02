import { EventEmitter } from 'events';
import { Keypair } from '@solana/web3.js';
import { logger } from '../../utils/logger.js';
import type { ParsedTransaction, LaunchPlatform, TransactionType } from '../collectors/TransactionStreamer.js';

export interface MockStreamerOptions {
  intervalMs?: number;
  platforms?: LaunchPlatform[];
  createTokenProbability?: number;
}

/**
 * Mock transaction streamer for testing without API keys
 * Generates realistic-looking mock transactions
 */
export class MockTransactionStreamer extends EventEmitter {
  private isRunning: boolean = false;
  private intervalMs: number;
  private platforms: LaunchPlatform[];
  private createTokenProbability: number;
  private intervalId?: NodeJS.Timeout;
  private transactionCount: number = 0;
  private slot: number = 300000000;

  constructor(options?: MockStreamerOptions) {
    super();
    this.intervalMs = options?.intervalMs ?? 2000;
    this.platforms = options?.platforms ?? ['pump.fun', 'letsbonk', 'moonshot'];
    this.createTokenProbability = options?.createTokenProbability ?? 0.1; // 10% chance
  }

  /**
   * Start generating mock transactions
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('MockTransactionStreamer already running');
      return;
    }

    this.isRunning = true;
    logger.info('MockTransactionStreamer starting...', {
      intervalMs: this.intervalMs,
      platforms: this.platforms,
    });

    this.emit('connected');

    this.intervalId = setInterval(() => {
      this.generateMockTransaction();
    }, this.intervalMs);

    // Generate first transaction immediately
    this.generateMockTransaction();
  }

  /**
   * Stop generating mock transactions
   */
  async stop(): Promise<void> {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    this.isRunning = false;
    this.emit('disconnected');
    logger.info('MockTransactionStreamer stopped', {
      totalTransactions: this.transactionCount,
    });
  }

  /**
   * Generate a single mock transaction
   */
  private generateMockTransaction(): void {
    const platform = this.platforms[Math.floor(Math.random() * this.platforms.length)];
    const isCreate = Math.random() < this.createTokenProbability;
    const type = this.determineTransactionType(isCreate);

    const tx = this.createMockTransaction(platform, type);
    this.transactionCount++;
    this.slot++;

    this.emit('transaction', tx);

    // Emit specific events
    switch (type) {
      case 'create':
        this.emit('newToken', tx);
        break;
      case 'buy':
      case 'sell':
        this.emit('swap', tx);
        break;
      case 'add_liquidity':
      case 'remove_liquidity':
        this.emit('liquidity', tx);
        break;
    }
  }

  /**
   * Determine transaction type
   */
  private determineTransactionType(isCreate: boolean): TransactionType {
    if (isCreate) return 'create';

    const rand = Math.random();
    if (rand < 0.45) return 'buy';
    if (rand < 0.9) return 'sell';
    if (rand < 0.95) return 'add_liquidity';
    return 'remove_liquidity';
  }

  /**
   * Create a mock transaction
   */
  private createMockTransaction(
    platform: LaunchPlatform,
    type: TransactionType
  ): ParsedTransaction {
    const tokenMint = Keypair.generate().publicKey.toBase58();
    const poolAddress = Keypair.generate().publicKey.toBase58();
    const walletAddress = Keypair.generate().publicKey.toBase58();
    const signature = this.generateMockSignature();

    // Generate realistic amounts
    const amountSol = BigInt(Math.floor(Math.random() * 10 * 1e9)); // 0-10 SOL
    const amountToken = BigInt(Math.floor(Math.random() * 1000000 * 1e6)); // Variable tokens

    return {
      signature,
      slot: this.slot,
      blockTime: Math.floor(Date.now() / 1000),
      platform,
      type,
      tokenMint,
      poolAddress,
      walletAddress,
      amountToken,
      amountSol,
      success: true,
    };
  }

  /**
   * Generate a mock base58 signature
   */
  private generateMockSignature(): string {
    const chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let sig = '';
    for (let i = 0; i < 88; i++) {
      sig += chars[Math.floor(Math.random() * chars.length)];
    }
    return sig;
  }

  /**
   * Get streamer statistics
   */
  getStats(): {
    isRunning: boolean;
    transactionCount: number;
    platforms: LaunchPlatform[];
    mode: 'mock';
  } {
    return {
      isRunning: this.isRunning,
      transactionCount: this.transactionCount,
      platforms: this.platforms,
      mode: 'mock',
    };
  }
}

export default MockTransactionStreamer;
