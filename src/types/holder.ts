export interface Holder {
  walletAddress: string;
  balance: bigint;
  percentage: number;
}

export interface HolderSnapshot {
  id: number;
  tokenId: number;
  totalHolders: number;
  top10Percentage: number;
  snapshotTime: Date;
}

export interface TopHolder {
  id: number;
  tokenId: number;
  walletAddress: string;
  balance: bigint;
  percentage: number;
  rank: number;
  snapshotTime: Date;
}

export interface HolderAnalysis {
  totalHolders: number;
  top10Percentage: number;
  top10Holders: Holder[];
  lastUpdated: Date;
}

// Holder update interval based on token state
export type TokenState = 'new' | 'early' | 'active' | 'mature';

export function getTokenState(createdAt: Date, holderCount: number): TokenState {
  const ageMs = Date.now() - createdAt.getTime();
  const ONE_HOUR = 3600_000;
  const ONE_DAY = 24 * ONE_HOUR;

  if (ageMs < ONE_HOUR) return 'new';         // Created within 1 hour
  if (ageMs < ONE_DAY) return 'early';        // Created within 24 hours
  if (holderCount < 1000) return 'active';    // Less than 1000 holders
  return 'mature';                             // 1000+ holders
}

export const HOLDER_UPDATE_INTERVALS: Record<TokenState, number> = {
  new: 60_000,        // 1 minute
  early: 300_000,     // 5 minutes
  active: 1_800_000,  // 30 minutes
  mature: 3_600_000,  // 1 hour
};
