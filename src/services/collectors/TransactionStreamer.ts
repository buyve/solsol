import { EventEmitter } from 'events';
import { SubscribeUpdate, SubscribeRequest, CommitmentLevel } from '@triton-one/yellowstone-grpc';
import { GrpcClient, PROGRAM_IDS } from '../external/GrpcClient.js';
import { logger } from '../../utils/logger.js';
import { signatureToBase58, bytesToBase58 } from '../../utils/solana.js';

// Transaction types
export type TransactionType = 'create' | 'buy' | 'sell' | 'add_liquidity' | 'remove_liquidity' | 'unknown';
export type LaunchPlatform = 'pump.fun' | 'letsbonk' | 'moonshot' | 'raydium' | 'unknown';

export interface ParsedTransaction {
  signature: string;
  slot: number;
  blockTime?: number;
  platform: LaunchPlatform;
  type: TransactionType;
  tokenMint?: string;
  poolAddress?: string;
  walletAddress?: string;
  amountToken?: bigint;
  amountSol?: bigint;
  success: boolean;
  rawData?: Uint8Array;
}

export interface StreamerOptions {
  platforms?: LaunchPlatform[];
  commitment?: CommitmentLevel;
  autoReconnect?: boolean;
}

export interface TransactionStreamerEvents {
  'transaction': (tx: ParsedTransaction) => void;
  'newToken': (tx: ParsedTransaction) => void;
  'swap': (tx: ParsedTransaction) => void;
  'liquidity': (tx: ParsedTransaction) => void;
  'error': (error: Error) => void;
  'connected': () => void;
  'disconnected': () => void;
}

export class TransactionStreamer extends EventEmitter {
  private grpcClient: GrpcClient;
  private isRunning: boolean = false;
  private platforms: LaunchPlatform[];
  private commitment: CommitmentLevel;
  private autoReconnect: boolean;
  private transactionCount: number = 0;

  constructor(options?: StreamerOptions) {
    super();
    this.grpcClient = new GrpcClient();
    this.platforms = options?.platforms || ['pump.fun', 'letsbonk', 'moonshot'];
    this.commitment = options?.commitment || CommitmentLevel.PROCESSED;
    this.autoReconnect = options?.autoReconnect ?? true;
  }

  /**
   * Start streaming transactions
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('TransactionStreamer is already running');
      return;
    }

    if (!this.grpcClient.isConfigured()) {
      throw new Error('gRPC client is not configured. Please set SHYFT_GRPC_TOKEN.');
    }

    this.isRunning = true;
    logger.info('Starting TransactionStreamer...', { platforms: this.platforms });

    try {
      await this.grpcClient.connect();
      this.emit('connected');

      const request = this.buildSubscriptionRequest();

      await this.grpcClient.subscribe(request, async (update) => {
        await this.handleUpdate(update);
      });
    } catch (error) {
      this.isRunning = false;
      this.emit('error', error as Error);
      logger.error('TransactionStreamer error', { error });

      if (this.autoReconnect) {
        logger.info('Attempting to reconnect in 5 seconds...');
        setTimeout(() => this.start(), 5000);
      }
    }
  }

  /**
   * Stop streaming
   */
  async stop(): Promise<void> {
    this.isRunning = false;
    await this.grpcClient.disconnect();
    this.emit('disconnected');
    logger.info('TransactionStreamer stopped', {
      totalTransactions: this.transactionCount
    });
  }

  /**
   * Build subscription request based on configured platforms
   */
  private buildSubscriptionRequest(): SubscribeRequest {
    const transactions: SubscribeRequest['transactions'] = {};

    if (this.platforms.includes('pump.fun')) {
      transactions['pumpfun'] = {
        vote: false,
        failed: false,
        accountInclude: [PROGRAM_IDS.PUMP_FUN],
        accountExclude: [],
        accountRequired: [],
      };
      transactions['pumpswap'] = {
        vote: false,
        failed: false,
        accountInclude: [PROGRAM_IDS.PUMP_SWAP_AMM],
        accountExclude: [],
        accountRequired: [],
      };
    }

    if (this.platforms.includes('letsbonk')) {
      transactions['letsbonk'] = {
        vote: false,
        failed: false,
        accountInclude: [PROGRAM_IDS.LETS_BONK],
        accountExclude: [],
        accountRequired: [],
      };
    }

    if (this.platforms.includes('moonshot')) {
      transactions['moonshot'] = {
        vote: false,
        failed: false,
        accountInclude: [PROGRAM_IDS.MOONSHOT],
        accountExclude: [],
        accountRequired: [],
      };
    }

    if (this.platforms.includes('raydium')) {
      transactions['raydium_amm'] = {
        vote: false,
        failed: false,
        accountInclude: [PROGRAM_IDS.RAYDIUM_AMM_V4],
        accountExclude: [],
        accountRequired: [],
      };
      transactions['raydium_cpmm'] = {
        vote: false,
        failed: false,
        accountInclude: [PROGRAM_IDS.RAYDIUM_CPMM],
        accountExclude: [],
        accountRequired: [],
      };
    }

    return {
      accounts: {},
      slots: {},
      transactions,
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      commitment: this.commitment,
      accountsDataSlice: [],
      ping: undefined,
    };
  }

  /**
   * Handle incoming subscription updates
   */
  private async handleUpdate(update: SubscribeUpdate): Promise<void> {
    if (!update.transaction) {
      return;
    }

    try {
      const parsed = this.parseTransaction(update);
      if (!parsed) return;

      this.transactionCount++;
      this.emit('transaction', parsed);

      // Emit specific events
      switch (parsed.type) {
        case 'create':
          this.emit('newToken', parsed);
          logger.info('New token detected', {
            platform: parsed.platform,
            mint: parsed.tokenMint,
            signature: parsed.signature.substring(0, 20) + '...',
          });
          break;
        case 'buy':
        case 'sell':
          this.emit('swap', parsed);
          break;
        case 'add_liquidity':
        case 'remove_liquidity':
          this.emit('liquidity', parsed);
          break;
      }
    } catch (error) {
      logger.error('Error parsing transaction', { error });
    }
  }

  /**
   * Parse a transaction update into a structured format
   */
  private parseTransaction(update: SubscribeUpdate): ParsedTransaction | null {
    const tx = update.transaction;
    if (!tx?.transaction) return null;

    const signature = tx.transaction.signature
      ? signatureToBase58(tx.transaction.signature)
      : '';
    const slot = Number(tx.slot || 0);

    // Determine platform
    const platform = this.detectPlatform(tx);

    // Determine transaction type
    const type = this.detectTransactionType(tx, platform);

    // Extract relevant addresses
    const addresses = this.extractAddresses(tx);

    // Check if transaction was successful
    const hasError = tx.transaction?.meta?.err !== undefined &&
                     tx.transaction?.meta?.err !== null;

    return {
      signature,
      slot,
      platform,
      type,
      tokenMint: addresses.tokenMint,
      poolAddress: addresses.poolAddress,
      walletAddress: addresses.walletAddress,
      success: !hasError,
      rawData: tx.transaction?.transaction ?
        new Uint8Array(Buffer.from(JSON.stringify(tx.transaction.transaction))) : undefined,
    };
  }

  /**
   * Detect which platform a transaction belongs to
   */
  private detectPlatform(tx: SubscribeUpdate['transaction']): LaunchPlatform {
    const message = tx?.transaction?.transaction?.message;
    if (!message?.accountKeys) return 'unknown';

    const accountKeys = message.accountKeys.map((key: Uint8Array) =>
      bytesToBase58(key)
    );

    // Check for known program IDs
    if (accountKeys.some((key: string) => key === PROGRAM_IDS.PUMP_FUN || key === PROGRAM_IDS.PUMP_SWAP_AMM)) {
      return 'pump.fun';
    }
    if (accountKeys.some((key: string) => key === PROGRAM_IDS.LETS_BONK)) {
      return 'letsbonk';
    }
    if (accountKeys.some((key: string) => key === PROGRAM_IDS.MOONSHOT)) {
      return 'moonshot';
    }
    if (accountKeys.some((key: string) =>
      key === PROGRAM_IDS.RAYDIUM_AMM_V4 ||
      key === PROGRAM_IDS.RAYDIUM_CPMM ||
      key === PROGRAM_IDS.RAYDIUM_CLMM
    )) {
      return 'raydium';
    }

    return 'unknown';
  }

  /**
   * Detect the type of transaction (create, buy, sell, etc.)
   */
  private detectTransactionType(
    tx: SubscribeUpdate['transaction'],
    platform: LaunchPlatform
  ): TransactionType {
    const message = tx?.transaction?.transaction?.message;
    if (!message?.instructions) return 'unknown';

    // Get instruction data to determine the type
    // This is a simplified detection - real implementation would parse instruction data
    const instructions = message.instructions;

    for (const ix of instructions) {
      const data = ix.data;
      if (!data || data.length === 0) continue;

      // Pump.fun instruction discriminators (first 8 bytes)
      // These are example discriminators - actual values need verification
      const discriminator = Buffer.from(data.slice(0, 8)).toString('hex');

      if (platform === 'pump.fun') {
        // Pump.fun create instruction
        if (discriminator.startsWith('181ec828')) {
          return 'create';
        }
        // Pump.fun buy instruction
        if (discriminator.startsWith('66063d12')) {
          return 'buy';
        }
        // Pump.fun sell instruction
        if (discriminator.startsWith('33e685a4')) {
          return 'sell';
        }
      }

      // LetsBONK/Raydium LaunchLab
      if (platform === 'letsbonk') {
        // Similar pattern for LetsBONK
        if (discriminator.startsWith('af4406a3')) {
          return 'create';
        }
        if (discriminator.startsWith('d5c1e8a7')) {
          return 'buy';
        }
        if (discriminator.startsWith('b4c2d1e0')) {
          return 'sell';
        }
      }

      // Moonshot
      if (platform === 'moonshot') {
        if (discriminator.startsWith('e9')) {
          return 'create';
        }
        if (discriminator.startsWith('b0')) {
          return 'buy';
        }
        if (discriminator.startsWith('c1')) {
          return 'sell';
        }
      }

      // Raydium AMM
      if (platform === 'raydium') {
        // Raydium swap instruction
        if (discriminator.startsWith('09')) {
          return 'buy'; // or sell, need more context
        }
        // Add liquidity
        if (discriminator.startsWith('03')) {
          return 'add_liquidity';
        }
        // Remove liquidity
        if (discriminator.startsWith('04')) {
          return 'remove_liquidity';
        }
      }
    }

    return 'unknown';
  }

  /**
   * Extract relevant addresses from transaction
   */
  private extractAddresses(tx: SubscribeUpdate['transaction']): {
    tokenMint?: string;
    poolAddress?: string;
    walletAddress?: string;
  } {
    const message = tx?.transaction?.transaction?.message;
    if (!message?.accountKeys) return {};

    const accountKeys = message.accountKeys.map((key: Uint8Array) =>
      bytesToBase58(key)
    );

    // First account is typically the fee payer (wallet)
    const walletAddress = accountKeys[0];

    // Token mint and pool addresses vary by instruction
    // This is a simplified extraction - real implementation needs instruction parsing
    let tokenMint: string | undefined;
    let poolAddress: string | undefined;

    // Look for accounts that match known patterns
    // In Pump.fun: account[2] is often the mint, account[3] is the bonding curve
    if (accountKeys.length > 3) {
      // These are heuristics - actual positions depend on the specific instruction
      tokenMint = accountKeys[2];
      poolAddress = accountKeys[3];
    }

    return { tokenMint, poolAddress, walletAddress };
  }

  /**
   * Get streamer statistics
   */
  getStats(): {
    isRunning: boolean;
    transactionCount: number;
    platforms: LaunchPlatform[];
  } {
    return {
      isRunning: this.isRunning,
      transactionCount: this.transactionCount,
      platforms: this.platforms,
    };
  }
}

// Export singleton instance
export const transactionStreamer = new TransactionStreamer();

export default TransactionStreamer;
