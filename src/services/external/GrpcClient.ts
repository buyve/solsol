// Use createRequire for CJS module compatibility in ESM
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Import yellowstone-grpc using require for proper CJS compatibility
const YellowstoneModule = require('@triton-one/yellowstone-grpc');
const {
  CommitmentLevel,
  default: Client,
} = YellowstoneModule;

// Re-export for other modules to use
export { CommitmentLevel };
// Export type for CommitmentLevel enum values
export type CommitmentLevelType = typeof CommitmentLevel[keyof typeof CommitmentLevel];

// Import types separately
import type { SubscribeRequest, SubscribeUpdate } from '@triton-one/yellowstone-grpc';
export type { SubscribeRequest, SubscribeUpdate };
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';

// Known program addresses
export const PROGRAM_IDS = {
  // Pump.fun
  PUMP_FUN: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  PUMP_SWAP_AMM: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  PUMP_FUN_FEE: 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',

  // LetsBONK.fun (Raydium LaunchLab)
  LETS_BONK: 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj',
  LETS_BONK_CREATOR_FILTER: 'FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1',

  // Moonshot
  MOONSHOT: 'MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG',

  // Raydium
  RAYDIUM_AMM_V4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  RAYDIUM_CPMM: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  RAYDIUM_CLMM: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',

  // Orca
  ORCA_WHIRLPOOL: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
} as const;

export type SubscriptionCallback = (update: SubscribeUpdate) => void | Promise<void>;

export interface GrpcClientOptions {
  endpoint?: string;
  token?: string;
  maxReconnectAttempts?: number;
  reconnectDelayMs?: number;
}

export interface SubscriptionOptions {
  name: string;
  programs?: string[];
  accounts?: string[];
  commitment?: CommitmentLevel;
  includeVote?: boolean;
  includeFailed?: boolean;
}

// Interface for the Yellowstone client
interface IYellowstoneClient {
  subscribe(): Promise<AsyncIterable<SubscribeUpdate> & { write: (request: SubscribeRequest) => void }>;
  ping(count: number): Promise<number>;
}

export class GrpcClient {
  // Using interface type for the client
  private client: IYellowstoneClient | null = null;
  private endpoint: string;
  private token: string;
  private maxReconnectAttempts: number;
  private reconnectDelayMs: number;
  private isConnectedFlag: boolean = false;
  private reconnectAttempt: number = 0;

  constructor(options?: GrpcClientOptions) {
    this.endpoint = options?.endpoint || config.shyft.grpcEndpoint;
    this.token = options?.token || config.shyft.grpcToken;
    this.maxReconnectAttempts = options?.maxReconnectAttempts || 10;
    this.reconnectDelayMs = options?.reconnectDelayMs || 1000;

    if (!this.token) {
      logger.warn('Shyft gRPC token is not configured');
    }
  }

  /**
   * Initialize and connect the gRPC client
   */
  async connect(): Promise<void> {
    if (this.isConnectedFlag && this.client) {
      logger.debug('gRPC client already connected');
      return;
    }

    try {
      logger.info('Connecting to Yellowstone gRPC...', { endpoint: this.endpoint });

      // Client is a class constructor
      this.client = new Client(this.endpoint, this.token, undefined) as IYellowstoneClient;
      this.isConnectedFlag = true;
      this.reconnectAttempt = 0;

      logger.info('Yellowstone gRPC connected successfully');
    } catch (error) {
      logger.error('Failed to connect to gRPC', { error });
      throw error;
    }
  }

  /**
   * Disconnect the gRPC client
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      this.isConnectedFlag = false;
      this.client = null;
      logger.info('gRPC client disconnected');
    }
  }

  /**
   * Handle reconnection with exponential backoff
   */
  private async handleReconnect(): Promise<boolean> {
    if (this.reconnectAttempt >= this.maxReconnectAttempts) {
      logger.error('Max reconnection attempts reached');
      return false;
    }

    this.reconnectAttempt++;
    const delay = this.reconnectDelayMs * Math.pow(2, this.reconnectAttempt - 1);

    logger.warn(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt}/${this.maxReconnectAttempts})`);

    await this.sleep(delay);

    try {
      await this.connect();
      return true;
    } catch (error) {
      logger.error('Reconnection failed', { error, attempt: this.reconnectAttempt });
      return this.handleReconnect();
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Create a subscription request for Pump.fun transactions
   */
  createPumpFunSubscription(): SubscribeRequest {
    return {
      accounts: {},
      slots: {},
      transactions: {
        pumpfun: {
          vote: false,
          failed: false,
          accountInclude: [PROGRAM_IDS.PUMP_FUN],
          accountExclude: [],
          accountRequired: [],
        },
      },
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      commitment: CommitmentLevel.PROCESSED,
      accountsDataSlice: [],
      ping: undefined,
    };
  }

  /**
   * Create a subscription request for LetsBONK.fun transactions
   */
  createLetsBonkSubscription(): SubscribeRequest {
    return {
      accounts: {},
      slots: {},
      transactions: {
        letsbonk: {
          vote: false,
          failed: false,
          accountInclude: [PROGRAM_IDS.LETS_BONK],
          accountExclude: [],
          accountRequired: [],
        },
      },
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      commitment: CommitmentLevel.PROCESSED,
      accountsDataSlice: [],
      ping: undefined,
    };
  }

  /**
   * Create a subscription for account changes (pool monitoring)
   */
  createAccountSubscription(accounts: string[]): SubscribeRequest {
    const accountsMap: SubscribeRequest['accounts'] = {};

    accounts.forEach((account, index) => {
      accountsMap[`account_${index}`] = {
        account: [account],
        owner: [],
        filters: [],
      };
    });

    return {
      accounts: accountsMap,
      slots: {},
      transactions: {},
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      commitment: CommitmentLevel.PROCESSED,
      accountsDataSlice: [],
      ping: undefined,
    };
  }

  /**
   * Create a combined subscription for multiple launchpads
   */
  createCombinedLaunchpadSubscription(): SubscribeRequest {
    return {
      accounts: {},
      slots: {},
      transactions: {
        pumpfun: {
          vote: false,
          failed: false,
          accountInclude: [PROGRAM_IDS.PUMP_FUN],
          accountExclude: [],
          accountRequired: [],
        },
        letsbonk: {
          vote: false,
          failed: false,
          accountInclude: [PROGRAM_IDS.LETS_BONK],
          accountExclude: [],
          accountRequired: [],
        },
        moonshot: {
          vote: false,
          failed: false,
          accountInclude: [PROGRAM_IDS.MOONSHOT],
          accountExclude: [],
          accountRequired: [],
        },
      },
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      commitment: CommitmentLevel.PROCESSED,
      accountsDataSlice: [],
      ping: undefined,
    };
  }

  /**
   * Subscribe to real-time updates
   */
  async subscribe(
    request: SubscribeRequest,
    callback: SubscriptionCallback
  ): Promise<void> {
    if (!this.client || !this.isConnectedFlag) {
      await this.connect();
    }

    if (!this.client) {
      throw new Error('Failed to initialize gRPC client');
    }

    try {
      logger.info('Starting gRPC subscription...', {
        hasTransactions: Object.keys(request.transactions || {}).length > 0,
        hasAccounts: Object.keys(request.accounts || {}).length > 0,
      });

      // Get duplex stream from client
      const stream = await this.client.subscribe();

      // Send the subscription request
      stream.write(request);

      logger.info('gRPC subscription started successfully');

      // Process incoming updates
      for await (const update of stream) {
        try {
          await callback(update);
        } catch (error) {
          logger.error('Error processing subscription update', { error });
        }
      }
    } catch (error) {
      logger.error('gRPC subscription error', { error });

      // Attempt reconnection
      const reconnected = await this.handleReconnect();
      if (reconnected) {
        // Re-subscribe after reconnection
        await this.subscribe(request, callback);
      } else {
        throw new Error('Failed to maintain gRPC connection');
      }
    }
  }

  /**
   * Process a transaction update
   */
  parseTransactionUpdate(update: SubscribeUpdate): {
    signature: string;
    slot: number;
    programs: string[];
    success: boolean;
  } | null {
    if (!update.transaction) {
      return null;
    }

    const tx = update.transaction;

    // Convert signature bytes to base58 (Solana standard format)
    const signature = tx.transaction?.signature
      ? this.bytesToBase58(tx.transaction.signature)
      : '';
    const slot = Number(tx.slot || 0);

    // Extract program IDs from instructions
    const programs: string[] = [];
    const message = tx.transaction?.transaction?.message;
    const knownProgramsSet: Set<string> = new Set(Object.values(PROGRAM_IDS));

    if (message?.accountKeys) {
      message.accountKeys.forEach((key: Uint8Array) => {
        // Convert raw bytes to base58 for proper comparison
        const pubkeyBase58 = this.bytesToBase58(key);

        // Check if this is a known program by comparing base58 strings
        if (knownProgramsSet.has(pubkeyBase58)) {
          programs.push(pubkeyBase58);
        }
      });
    }

    // Check for transaction error
    const hasError = tx.transaction?.meta?.err !== undefined && tx.transaction?.meta?.err !== null;

    return {
      signature,
      slot,
      programs,
      success: !hasError,
    };
  }

  /**
   * Convert raw bytes to base58 string (Solana public key format)
   */
  private bytesToBase58(bytes: Uint8Array | Buffer): string {
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const buffer = Buffer.from(bytes);

    if (buffer.length === 0) return '';

    // Count leading zeros
    let leadingZeros = 0;
    for (let i = 0; i < buffer.length && buffer[i] === 0; i++) {
      leadingZeros++;
    }

    // Convert bytes to big integer
    let num = BigInt('0x' + buffer.toString('hex'));
    let result = '';

    while (num > 0n) {
      const remainder = Number(num % 58n);
      num = num / 58n;
      result = alphabet[remainder] + result;
    }

    // Add leading '1's for zero bytes
    return '1'.repeat(leadingZeros) + result;
  }

  /**
   * Check if the client is properly configured
   */
  isConfigured(): boolean {
    return !!this.token;
  }

  /**
   * Get connection status
   */
  getStatus(): { connected: boolean; reconnectAttempts: number } {
    return {
      connected: this.isConnectedFlag,
      reconnectAttempts: this.reconnectAttempt,
    };
  }
}

// Export singleton instance
export const grpcClient = new GrpcClient();

export default GrpcClient;
