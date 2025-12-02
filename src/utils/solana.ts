import { PublicKey } from '@solana/web3.js';

/**
 * Solana-specific utility functions
 */

/**
 * Validate Solana address (base58 encoded public key)
 */
export function isValidSolanaAddress(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Shorten address for display
 */
export function shortenAddress(address: string, chars: number = 4): string {
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

/**
 * Known program addresses
 */
export const KNOWN_PROGRAMS = {
  // Launchpads
  PUMPFUN: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  PUMPSWAP_AMM: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  LETSBONK: 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj',
  MOONSHOT: 'MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG',

  // DEXes
  RAYDIUM_AMM_V4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  RAYDIUM_CPMM: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  RAYDIUM_CLMM: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  ORCA_WHIRLPOOL: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',

  // Solana system
  SYSTEM_PROGRAM: '11111111111111111111111111111111',
  TOKEN_PROGRAM: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  TOKEN_2022_PROGRAM: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  ASSOCIATED_TOKEN_PROGRAM: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
} as const;

/**
 * Get program name from address
 */
export function getProgramName(address: string): string | null {
  for (const [name, programAddress] of Object.entries(KNOWN_PROGRAMS)) {
    if (programAddress === address) {
      return name;
    }
  }
  return null;
}

/**
 * Common token mints
 */
export const TOKEN_MINTS = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
} as const;

/**
 * Derive PDA (Program Derived Address)
 */
export async function findPDA(
  programId: string,
  seeds: (Buffer | Uint8Array)[]
): Promise<[PublicKey, number]> {
  return PublicKey.findProgramAddress(
    seeds,
    new PublicKey(programId)
  );
}

/**
 * Convert base58 to bytes
 */
export function base58ToBytes(base58: string): Uint8Array {
  return new PublicKey(base58).toBytes();
}

/**
 * Convert bytes to base58 string
 */
export function bytesToBase58(bytes: Uint8Array | Buffer): string {
  try {
    return new PublicKey(bytes).toBase58();
  } catch {
    // If the bytes don't represent a valid public key, use a hex fallback
    return Buffer.from(bytes).toString('hex');
  }
}

/**
 * Encode signature bytes to base58
 * Signatures are 64 bytes, not 32 bytes like public keys
 */
export function signatureToBase58(signatureBytes: Uint8Array | Buffer): string {
  // For 64-byte signatures, we can't use PublicKey
  // Use a simple base58 encoding alternative
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const bytes = Buffer.from(signatureBytes);

  if (bytes.length === 0) return '';

  // Convert bytes to big integer
  let num = BigInt('0x' + bytes.toString('hex'));
  let result = '';

  while (num > 0n) {
    const remainder = Number(num % 58n);
    num = num / 58n;
    result = alphabet[remainder] + result;
  }

  // Add leading 1s for zero bytes
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
    result = '1' + result;
  }

  return result;
}
