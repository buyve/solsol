export interface LiquidityPool {
  id: number;
  tokenId: number;
  poolAddress: string;
  dexName: DexName;
  baseMint: string;
  quoteMint: string;
  baseReserve: bigint;
  quoteReserve: bigint;
  liquidityUsd: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PoolCreate {
  tokenId: number;
  poolAddress: string;
  dexName: DexName;
  baseMint: string;
  quoteMint: string;
  baseReserve?: bigint;
  quoteReserve?: bigint;
  liquidityUsd?: number;
}

export type DexName =
  | 'pumpfun_amm'
  | 'raydium_amm_v4'
  | 'raydium_cpmm'
  | 'raydium_clmm'
  | 'raydium_launchlab'
  | 'orca'
  | 'orca_whirlpool'
  | 'meteora'
  | 'meteora_dlmm'
  | 'unknown';

export interface PoolReserves {
  poolAddress: string;
  baseReserve: bigint;
  quoteReserve: bigint;
  baseDecimals: number;
  quoteDecimals: number;
  updatedAt: Date;
}

export interface PoolInfo {
  poolAddress: string;
  dexName: DexName;
  baseMint: string;
  quoteMint: string;
  baseReserve: bigint;
  quoteReserve: bigint;
  liquidityUsd: number;
  priceInQuote: number;
}
