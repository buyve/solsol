export interface Token {
  id: number;
  mintAddress: string;
  name: string | null;
  symbol: string | null;
  decimals: number;
  totalSupply: bigint;
  metadataUri: string | null;
  launchPlatform: string | null;
  createdAt: Date;
  updatedAt: Date;
  isActive: boolean;
}

export interface TokenCreateInput {
  mintAddress: string;
  name?: string;
  symbol?: string;
  decimals?: number;
  totalSupply?: bigint;
  metadataUri?: string;
  launchPlatform?: string;
}

export interface TokenInfo {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  isInitialized: boolean;
}

export interface PriceData {
  tokenId: number;
  priceSol: number;
  priceUsd: number;
  solUsdRate: number;
  timestamp: Date;
}

export interface MarketCapData {
  tokenId: number;
  marketCapUsd: number;
  fdvUsd: number;
  circulatingSupply: bigint;
  timestamp: Date;
}

export interface MonitoredToken {
  id: number;
  tokenId: number;
  priority: number;
  updateIntervalSec: number;
  lastPriceUpdate: Date | null;
  lastHolderUpdate: Date | null;
  addedAt: Date;
}

export type TokenStatus = 'new' | 'early' | 'active' | 'mature';

export function getTokenStatus(createdAt: Date, holderCount: number): TokenStatus {
  const ageMs = Date.now() - createdAt.getTime();
  const ONE_HOUR = 3600_000;
  const ONE_DAY = 24 * ONE_HOUR;

  if (ageMs < ONE_HOUR) return 'new';
  if (ageMs < ONE_DAY) return 'early';
  if (holderCount < 1000) return 'active';
  return 'mature';
}
