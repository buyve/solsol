export interface Token {
  id: number;
  mintAddress: string;
  name: string | null;
  symbol: string | null;
  decimals: number;
  totalSupply: bigint | null;
  metadataUri: string | null;
  launchPlatform: LaunchPlatform | null;
  createdAt: Date;
  updatedAt: Date;
  isActive: boolean;
}

export interface TokenCreate {
  mintAddress: string;
  name?: string;
  symbol?: string;
  decimals?: number;
  totalSupply?: bigint;
  metadataUri?: string;
  launchPlatform?: LaunchPlatform;
}

export type LaunchPlatform =
  | 'pumpfun'
  | 'pumpswap'
  | 'letsbonk'
  | 'moonshot'
  | 'raydium'
  | 'unknown';

export interface PriceHistory {
  id: number;
  tokenId: number;
  priceSol: number;
  priceUsd: number;
  solUsdRate: number;
  timestamp: Date;
}

export interface MarketCapHistory {
  id: number;
  tokenId: number;
  marketCapUsd: number;
  fdvUsd: number;
  circulatingSupply: bigint;
  timestamp: Date;
}

export interface TokenPrice {
  mintAddress: string;
  priceSol: number;
  priceUsd: number;
  solUsdRate: number;
  updatedAt: Date;
}

// Launchpad program addresses
export const LAUNCHPAD_PROGRAMS = {
  PUMPFUN: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  PUMPSWAP_AMM: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  PUMPFUN_FEE: 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',
  LETSBONK: 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj',
  LETSBONK_FILTER: 'FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1',
  MOONSHOT: 'MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG',
  RAYDIUM_AMM_V4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  RAYDIUM_CPMM: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  RAYDIUM_CLMM: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  ORCA_WHIRLPOOL: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
} as const;

// SOL mint address
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
