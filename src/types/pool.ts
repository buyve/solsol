export interface LiquidityPool {
  id: number;
  tokenId: number;
  poolAddress: string;
  dexName: string;
  baseMint: string;
  quoteMint: string;
  baseReserve: bigint;
  quoteReserve: bigint;
  liquidityUsd: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PoolCreateInput {
  tokenId: number;
  poolAddress: string;
  dexName: string;
  baseMint: string;
  quoteMint: string;
  baseReserve?: bigint;
  quoteReserve?: bigint;
  liquidityUsd?: number;
}

export interface PoolReserves {
  baseReserve: bigint;
  quoteReserve: bigint;
  baseDecimals: number;
  quoteDecimals: number;
}

export interface PoolPriceInfo {
  poolAddress: string;
  tokenMint: string;
  priceSol: number;
  priceUsd: number;
  liquidityUsd: number;
  dexName: string;
}

export type DexType = 'raydium' | 'orca' | 'pumpfun' | 'jupiter' | 'unknown';

export const DEX_PROGRAM_IDS: Record<DexType, string> = {
  raydium: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  orca: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  pumpfun: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  jupiter: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  unknown: '',
};

export function identifyDex(programId: string): DexType {
  for (const [dex, id] of Object.entries(DEX_PROGRAM_IDS)) {
    if (id === programId) return dex as DexType;
  }
  return 'unknown';
}
