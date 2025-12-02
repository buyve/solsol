export interface Holder {
  walletAddress: string;
  balance: bigint;
  percentage: number;
  rank?: number;
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
  top10Holders: Holder[];
  top10Percentage: number;
  top10TotalBalance: bigint;
  snapshotTime: Date;
}

export interface HolderChange {
  walletAddress: string;
  previousBalance: bigint;
  currentBalance: bigint;
  changeAmount: bigint;
  changePercent: number;
  changeType: 'increase' | 'decrease' | 'new' | 'exit';
}

export interface HolderDistribution {
  whales: number;      // > 1% of supply
  large: number;       // 0.1% - 1%
  medium: number;      // 0.01% - 0.1%
  small: number;       // < 0.01%
}

export function calculateTop10Percentage(
  holders: Holder[],
  totalSupply: bigint
): { percentage: number; holders: Holder[] } {
  const sorted = [...holders].sort((a, b) => {
    if (b.balance > a.balance) return 1;
    if (b.balance < a.balance) return -1;
    return 0;
  });

  const top10 = sorted.slice(0, 10).map((h, index) => ({
    ...h,
    rank: index + 1,
  }));

  const top10Sum = top10.reduce((sum, h) => sum + h.balance, 0n);
  const percentage = Number((top10Sum * 10000n) / totalSupply) / 100;

  return { percentage, holders: top10 };
}

export function categorizeHolders(
  holders: Holder[],
  totalSupply: bigint
): HolderDistribution {
  const distribution: HolderDistribution = {
    whales: 0,
    large: 0,
    medium: 0,
    small: 0,
  };

  for (const holder of holders) {
    const percentage = Number((holder.balance * 10000n) / totalSupply) / 100;

    if (percentage > 1) {
      distribution.whales++;
    } else if (percentage > 0.1) {
      distribution.large++;
    } else if (percentage > 0.01) {
      distribution.medium++;
    } else {
      distribution.small++;
    }
  }

  return distribution;
}
