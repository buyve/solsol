import { EventEmitter } from 'events';
import { GrpcClient, PROGRAM_IDS, CommitmentLevel } from '../external/GrpcClient.js';
import type { SubscribeUpdate, SubscribeRequest, CommitmentLevelType } from '../external/GrpcClient.js';
import { logger } from '../../utils/logger.js';
import { signatureToBase58, bytesToBase58 } from '../../utils/solana.js';

// Transaction types
export type TransactionType = 'create' | 'buy' | 'sell' | 'add_liquidity' | 'remove_liquidity' | 'unknown';
export type LaunchPlatform = 'pump.fun' | 'letsbonk' | 'moonshot' | 'raydium' | 'unknown';

/**
 * Instruction discriminators for each platform
 * These are the first 8 bytes of each instruction that identify its type
 * Derived from Anchor's sighash: sha256("global:<instruction_name>")[0..8]
 */
const INSTRUCTION_DISCRIMINATORS = {
  // Pump.fun discriminators (verified from on-chain transactions)
  PUMP_FUN: {
    // Note: pump.fun may use multiple instruction names for token creation
    CREATE: Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]),           // "create" (anchor sighash)
    CREATE_ALT: Buffer.from([20, 22, 86, 123, 198, 28, 219, 132]),   // alternative create discriminator (observed)
    BUY: Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]),             // buy
    SELL: Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]),         // sell
  },
  // PumpSwap AMM discriminators
  PUMP_SWAP: {
    SWAP: Buffer.from([248, 198, 158, 145, 225, 117, 135, 200]),  // swap
    ADD_LIQUIDITY: Buffer.from([103, 148, 192, 67, 14, 15, 179, 190]),
    REMOVE_LIQUIDITY: Buffer.from([183, 18, 70, 156, 148, 109, 161, 34]),
  },
  // LetsBONK / Raydium LaunchLab discriminators
  LETS_BONK: {
    CREATE: Buffer.from([175, 175, 109, 31, 13, 152, 155, 237]),  // initialize
    BUY: Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]),         // buy (same pattern)
    SELL: Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]),     // sell
  },
  // Moonshot discriminators
  MOONSHOT: {
    CREATE: Buffer.from([233, 146, 209, 142, 207, 104, 64, 188]), // initialize
    BUY: Buffer.from([176, 27, 174, 244, 167, 109, 47, 63]),      // buy
    SELL: Buffer.from([193, 37, 29, 24, 145, 19, 133, 244]),      // sell
  },
  // Raydium AMM V4 instruction indices (not Anchor-based, uses single byte)
  RAYDIUM_AMM: {
    SWAP_BASE_IN: 9,
    SWAP_BASE_OUT: 11,
    ADD_LIQUIDITY: 3,
    REMOVE_LIQUIDITY: 4,
    INITIALIZE: 0,
  },
} as const;

export interface ParsedTransaction {
  signature: string;
  slot: number;
  blockTime?: number;
  platform: LaunchPlatform;
  type: TransactionType;
  tokenMint?: string;
  poolAddress?: string;
  walletAddress?: string;
  amountToken?: bigint;       // Actual executed token amount (raw, with decimals)
  amountSol?: bigint;         // Actual executed SOL amount (in lamports)
  tokenDecimals?: number;     // Token decimals for proper formatting
  success: boolean;
  rawData?: Uint8Array;
}

export interface StreamerOptions {
  platforms?: LaunchPlatform[];
  commitment?: CommitmentLevelType;
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
  private commitment: CommitmentLevelType;
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
   * Start streaming transactions (non-blocking)
   * gRPC subscription runs in background, allowing bootstrap to complete
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

      // Run subscription in background (non-blocking)
      // This allows startFullServices() to continue and start other services
      this.runSubscriptionLoop(request);

      logger.info('TransactionStreamer subscription started in background');
    } catch (error) {
      this.isRunning = false;
      this.emit('error', error as Error);
      logger.error('TransactionStreamer connection error', { error });

      if (this.autoReconnect) {
        logger.info('Attempting to reconnect in 5 seconds...');
        setTimeout(() => this.start(), 5000);
      }
    }
  }

  /**
   * Run gRPC subscription loop in background
   */
  private runSubscriptionLoop(request: SubscribeRequest): void {
    // Fire and forget - runs in background
    this.grpcClient.subscribe(request, async (update) => {
      await this.handleUpdate(update);
    }).catch((error) => {
      if (!this.isRunning) return; // Expected during shutdown

      this.emit('error', error as Error);
      logger.error('TransactionStreamer subscription error', { error });

      if (this.autoReconnect && this.isRunning) {
        logger.info('Attempting to reconnect in 5 seconds...');
        setTimeout(() => {
          if (this.isRunning) {
            this.runSubscriptionLoop(request);
          }
        }, 5000);
      }
    });
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

    // Extract relevant addresses and amounts
    const extracted = this.extractAddresses(tx);

    // Check if transaction was successful
    const hasError = tx.transaction?.meta?.err !== undefined &&
                     tx.transaction?.meta?.err !== null;

    return {
      signature,
      slot,
      platform,
      type,
      tokenMint: extracted.tokenMint,
      poolAddress: extracted.poolAddress,
      walletAddress: extracted.walletAddress,
      amountToken: extracted.amountToken,
      amountSol: extracted.amountSol,
      tokenDecimals: extracted.tokenDecimals,
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
   * Uses verified instruction discriminators for accurate classification
   */
  private detectTransactionType(
    tx: SubscribeUpdate['transaction'],
    platform: LaunchPlatform
  ): TransactionType {
    const message = tx?.transaction?.transaction?.message;
    if (!message?.instructions) return 'unknown';

    const accountKeys = message.accountKeys?.map((key: Uint8Array) =>
      bytesToBase58(key)
    ) || [];

    for (const ix of message.instructions) {
      const data = ix.data;
      if (!data || data.length === 0) continue;

      const dataBuffer = Buffer.from(data);

      // Check which program this instruction is for
      const programIndex = ix.programIdIndex;
      const programId = accountKeys[programIndex];

      // Pump.fun Bonding Curve instructions (Anchor-based)
      if (programId === PROGRAM_IDS.PUMP_FUN) {
        // Debug: log first 8 bytes of instruction data
        if (dataBuffer.length >= 8) {
          logger.debug('Pump.fun instruction detected', {
            discriminator: Array.from(dataBuffer.subarray(0, 8)).join(','),
            expectedCreate: Array.from(INSTRUCTION_DISCRIMINATORS.PUMP_FUN.CREATE).join(','),
            expectedBuy: Array.from(INSTRUCTION_DISCRIMINATORS.PUMP_FUN.BUY).join(','),
            expectedSell: Array.from(INSTRUCTION_DISCRIMINATORS.PUMP_FUN.SELL).join(','),
          });
        }
        const type = this.matchAnchorDiscriminator(dataBuffer, 'PUMP_FUN');
        if (type !== 'unknown') return type;
      }

      // PumpSwap AMM instructions
      if (programId === PROGRAM_IDS.PUMP_SWAP_AMM) {
        const type = this.matchAnchorDiscriminator(dataBuffer, 'PUMP_SWAP');
        if (type !== 'unknown') return type;
      }

      // LetsBONK / Raydium LaunchLab (Anchor-based)
      if (programId === PROGRAM_IDS.LETS_BONK) {
        const type = this.matchAnchorDiscriminator(dataBuffer, 'LETS_BONK');
        if (type !== 'unknown') return type;
      }

      // Moonshot (Anchor-based)
      if (programId === PROGRAM_IDS.MOONSHOT) {
        const type = this.matchAnchorDiscriminator(dataBuffer, 'MOONSHOT');
        if (type !== 'unknown') return type;
      }

      // Raydium AMM V4 (non-Anchor, uses single byte instruction index)
      if (programId === PROGRAM_IDS.RAYDIUM_AMM_V4) {
        const instructionIndex = dataBuffer[0];
        return this.matchRaydiumInstruction(instructionIndex);
      }
    }

    return 'unknown';
  }

  /**
   * Match Anchor-style 8-byte discriminator
   */
  private matchAnchorDiscriminator(
    data: Buffer,
    platformKey: 'PUMP_FUN' | 'PUMP_SWAP' | 'LETS_BONK' | 'MOONSHOT'
  ): TransactionType {
    if (data.length < 8) return 'unknown';

    const discriminator = data.subarray(0, 8);
    const platformDiscriminators = INSTRUCTION_DISCRIMINATORS[platformKey];

    // Check CREATE
    if ('CREATE' in platformDiscriminators &&
        discriminator.equals(platformDiscriminators.CREATE as Buffer)) {
      return 'create';
    }

    // Check CREATE_ALT (alternative create discriminator for pump.fun)
    if ('CREATE_ALT' in platformDiscriminators &&
        discriminator.equals((platformDiscriminators as typeof INSTRUCTION_DISCRIMINATORS.PUMP_FUN).CREATE_ALT)) {
      return 'create';
    }

    // Check BUY
    if ('BUY' in platformDiscriminators &&
        discriminator.equals(platformDiscriminators.BUY as Buffer)) {
      return 'buy';
    }

    // Check SELL
    if ('SELL' in platformDiscriminators &&
        discriminator.equals(platformDiscriminators.SELL as Buffer)) {
      return 'sell';
    }

    // Check SWAP (PumpSwap)
    if ('SWAP' in platformDiscriminators &&
        discriminator.equals((platformDiscriminators as typeof INSTRUCTION_DISCRIMINATORS.PUMP_SWAP).SWAP)) {
      // For swap, we need to determine direction from accounts/amounts
      // Default to 'buy' but could be refined with more context
      return 'buy';
    }

    // Check ADD_LIQUIDITY
    if ('ADD_LIQUIDITY' in platformDiscriminators &&
        discriminator.equals((platformDiscriminators as typeof INSTRUCTION_DISCRIMINATORS.PUMP_SWAP).ADD_LIQUIDITY)) {
      return 'add_liquidity';
    }

    // Check REMOVE_LIQUIDITY
    if ('REMOVE_LIQUIDITY' in platformDiscriminators &&
        discriminator.equals((platformDiscriminators as typeof INSTRUCTION_DISCRIMINATORS.PUMP_SWAP).REMOVE_LIQUIDITY)) {
      return 'remove_liquidity';
    }

    return 'unknown';
  }

  /**
   * Match Raydium AMM V4 instruction index (single byte)
   */
  private matchRaydiumInstruction(index: number): TransactionType {
    const raydium = INSTRUCTION_DISCRIMINATORS.RAYDIUM_AMM;

    switch (index) {
      case raydium.INITIALIZE:
        return 'create';
      case raydium.SWAP_BASE_IN:
      case raydium.SWAP_BASE_OUT:
        // Swap direction would need amount analysis
        return 'buy';
      case raydium.ADD_LIQUIDITY:
        return 'add_liquidity';
      case raydium.REMOVE_LIQUIDITY:
        return 'remove_liquidity';
      default:
        return 'unknown';
    }
  }

  /**
   * Extract relevant addresses from transaction
   * Uses platform-specific account layouts for accurate extraction
   */
  private extractAddresses(tx: SubscribeUpdate['transaction']): {
    tokenMint?: string;
    poolAddress?: string;
    walletAddress?: string;
    amountToken?: bigint;
    amountSol?: bigint;
    tokenDecimals?: number;
  } {
    const message = tx?.transaction?.transaction?.message;
    const meta = tx?.transaction?.meta;
    if (!message?.accountKeys) return {};

    const accountKeys = message.accountKeys.map((key: Uint8Array) =>
      bytesToBase58(key)
    );

    // First account is typically the fee payer (wallet)
    const walletAddress = accountKeys[0];

    let tokenMint: string | undefined;
    let poolAddress: string | undefined;
    let amountToken: bigint | undefined;
    let amountSol: bigint | undefined;
    let tokenDecimals: number | undefined;

    // Parse each instruction to find relevant addresses
    for (const ix of message.instructions || []) {
      const programIndex = ix.programIdIndex;
      const programId = accountKeys[programIndex];
      const ixAccounts = ix.accounts || [];

      // Map instruction account indices to actual account keys
      const getAccount = (index: number) => accountKeys[ixAccounts[index]];

      // Pump.fun account layout
      // create: [fee_payer, mint, bonding_curve, associated_bonding_curve, ...]
      // buy/sell: [fee_payer, fee_recipient, mint, bonding_curve, ...]
      if (programId === PROGRAM_IDS.PUMP_FUN) {
        const data = Buffer.from(ix.data || []);
        if (data.length >= 8) {
          const discriminator = data.subarray(0, 8);

          if (discriminator.equals(INSTRUCTION_DISCRIMINATORS.PUMP_FUN.CREATE) ||
              discriminator.equals(INSTRUCTION_DISCRIMINATORS.PUMP_FUN.CREATE_ALT)) {
            tokenMint = getAccount(1);      // mint
            poolAddress = getAccount(2);    // bonding_curve
          } else if (discriminator.equals(INSTRUCTION_DISCRIMINATORS.PUMP_FUN.BUY) ||
                     discriminator.equals(INSTRUCTION_DISCRIMINATORS.PUMP_FUN.SELL)) {
            tokenMint = getAccount(2);      // mint
            poolAddress = getAccount(3);    // bonding_curve
            // Note: Don't extract amounts from instruction data here
            // Actual amounts will be extracted from balance changes below
          }
        }
      }

      // PumpSwap AMM account layout
      if (programId === PROGRAM_IDS.PUMP_SWAP_AMM) {
        // Pool is usually account[0], token accounts follow
        poolAddress = getAccount(0);
        // Token mint would need to be fetched from pool account data
      }

      // LetsBONK / Raydium LaunchLab
      if (programId === PROGRAM_IDS.LETS_BONK) {
        const data = Buffer.from(ix.data || []);
        if (data.length >= 8) {
          // Similar pattern to Pump.fun
          tokenMint = getAccount(1);
          poolAddress = getAccount(2);
          // Note: Don't extract amounts from instruction data here
        }
      }

      // Moonshot
      if (programId === PROGRAM_IDS.MOONSHOT) {
        tokenMint = getAccount(1);
        poolAddress = getAccount(2);
      }

      // Raydium AMM V4
      // swap: [token_program, amm, authority, open_orders, target_orders, coin_vault, pc_vault, ...]
      if (programId === PROGRAM_IDS.RAYDIUM_AMM_V4) {
        poolAddress = getAccount(1);  // amm account
        // Token mints are stored in the AMM account data
      }

      // If we found addresses, return early from instruction loop
      if (tokenMint || poolAddress) break;
    }

    // Extract ACTUAL executed amounts from balance changes (not instruction data)
    // This captures real slippage, fees, and executed amounts
    if (meta && tokenMint) {
      const extracted = this.extractActualAmounts(meta, accountKeys, walletAddress, tokenMint);
      amountSol = extracted.amountSol;
      amountToken = extracted.amountToken;
      tokenDecimals = extracted.tokenDecimals;
    }

    return { tokenMint, poolAddress, walletAddress, amountToken, amountSol, tokenDecimals };
  }

  /**
   * Extract actual executed amounts from transaction meta balance changes
   * This gives us the REAL amounts after slippage and fees
   */
  private extractActualAmounts(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    meta: any,
    accountKeys: string[],
    walletAddress: string,
    tokenMint: string
  ): {
    amountSol?: bigint;
    amountToken?: bigint;
    tokenDecimals?: number;
  } {
    if (!meta) return {};

    let amountSol: bigint | undefined;
    let amountToken: bigint | undefined;
    let tokenDecimals: number | undefined;

    // Extract SOL amount from lamport balance changes
    // preBalances and postBalances are arrays aligned with accountKeys
    const preBalances = meta.preBalances || [];
    const postBalances = meta.postBalances || [];

    // Find wallet's SOL balance change (index 0 is typically fee payer)
    const walletIndex = accountKeys.indexOf(walletAddress);
    if (walletIndex >= 0 && preBalances[walletIndex] !== undefined && postBalances[walletIndex] !== undefined) {
      const preSol = BigInt(preBalances[walletIndex] || 0);
      const postSol = BigInt(postBalances[walletIndex] || 0);
      // Absolute difference (ignore transaction fee for now, it's small ~5000 lamports)
      const solDiff = preSol > postSol ? preSol - postSol : postSol - preSol;
      // Only count if significant (> 0.001 SOL = 1000000 lamports, to exclude just tx fees)
      if (solDiff > BigInt(1000000)) {
        amountSol = solDiff;
      }
    }

    // Extract token amount from token balance changes
    // preTokenBalances and postTokenBalances contain token account info
    const preTokenBalances = meta.preTokenBalances || [];
    const postTokenBalances = meta.postTokenBalances || [];

    // Find token balance changes for our token mint owned by wallet
    for (let i = 0; i < Math.max(preTokenBalances.length, postTokenBalances.length); i++) {
      const preBalance = preTokenBalances.find(
        (b: { accountIndex: number; mint: string; owner: string }) =>
          b.mint === tokenMint && b.owner === walletAddress
      );
      const postBalance = postTokenBalances.find(
        (b: { accountIndex: number; mint: string; owner: string }) =>
          b.mint === tokenMint && b.owner === walletAddress
      );

      if (preBalance || postBalance) {
        const preAmount = BigInt(preBalance?.uiTokenAmount?.amount || '0');
        const postAmount = BigInt(postBalance?.uiTokenAmount?.amount || '0');
        const tokenDiff = preAmount > postAmount ? preAmount - postAmount : postAmount - preAmount;

        if (tokenDiff > BigInt(0)) {
          amountToken = tokenDiff;
          tokenDecimals = preBalance?.uiTokenAmount?.decimals || postBalance?.uiTokenAmount?.decimals;
        }
        break;
      }
    }

    // Fallback: if no wallet-owned token account found, look for any significant token change
    if (!amountToken) {
      for (const postBal of postTokenBalances) {
        if (postBal.mint === tokenMint) {
          const matchingPre = preTokenBalances.find(
            (b: { accountIndex: number }) => b.accountIndex === postBal.accountIndex
          );
          const preAmount = BigInt(matchingPre?.uiTokenAmount?.amount || '0');
          const postAmount = BigInt(postBal.uiTokenAmount?.amount || '0');
          const diff = preAmount > postAmount ? preAmount - postAmount : postAmount - preAmount;

          if (diff > BigInt(0)) {
            amountToken = diff;
            tokenDecimals = postBal.uiTokenAmount?.decimals;
            break;
          }
        }
      }
    }

    return { amountSol, amountToken, tokenDecimals };
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
