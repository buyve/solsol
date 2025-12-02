/**
 * Native SOL mint address
 */
export const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Wrapped SOL mint address
 */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Pump.fun program ID
 */
export const PUMPFUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

/**
 * Raydium AMM program ID
 */
export const RAYDIUM_AMM_PROGRAM_ID = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

/**
 * Validate Solana address format
 */
export function isValidSolanaAddress(address: string): boolean {
  // Base58 alphabet
  const base58Regex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  return base58Regex.test(address);
}

/**
 * Shorten address for display
 */
export function shortenAddress(address: string, chars: number = 4): string {
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

/**
 * Check if address is the native SOL mint
 */
export function isNativeSol(mintAddress: string): boolean {
  return mintAddress === NATIVE_SOL_MINT || mintAddress === WSOL_MINT;
}

/**
 * Sleep utility for rate limiting
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry with exponential backoff
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  initialDelayMs: number = 1000
): Promise<T> {
  let lastError: Error | null = null;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const delay = initialDelayMs * Math.pow(2, i);
      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Parse slot from block time
 */
export function estimateSlotFromTime(timestampMs: number): number {
  // Solana produces ~400ms per slot
  const SLOT_TIME_MS = 400;
  const REFERENCE_SLOT = 200_000_000;
  const REFERENCE_TIME = 1700000000000; // Approximate reference

  const timeDiff = timestampMs - REFERENCE_TIME;
  return REFERENCE_SLOT + Math.floor(timeDiff / SLOT_TIME_MS);
}
