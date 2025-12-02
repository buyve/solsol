export interface Transaction {
  id: number;
  signature: string;
  tokenId: number;
  poolId: number | null;
  txType: TransactionType;
  walletAddress: string | null;
  amountToken: bigint;
  amountSol: bigint;
  priceAtTx: number;
  blockTime: Date;
  slot: number;
}

export type TransactionType = 'buy' | 'sell' | 'transfer' | 'mint' | 'burn' | 'unknown';

export interface TransactionCreateInput {
  signature: string;
  tokenId: number;
  poolId?: number;
  txType: TransactionType;
  walletAddress?: string;
  amountToken: bigint;
  amountSol: bigint;
  priceAtTx: number;
  blockTime: Date;
  slot: number;
}

export interface SwapEvent {
  signature: string;
  poolAddress: string;
  tokenMint: string;
  walletAddress: string;
  type: 'buy' | 'sell';
  tokenAmount: bigint;
  solAmount: bigint;
  pricePerToken: number;
  timestamp: number;
  slot: number;
}

export interface VolumeStats {
  tokenId: number;
  volume24hSol: number;
  volume24hUsd: number;
  buyCount24h: number;
  sellCount24h: number;
  buyVolume24hSol: number;
  sellVolume24hSol: number;
  timestamp: Date;
}

export interface VolumeAggregation {
  buyVolume: number;
  sellVolume: number;
  buyCount: number;
  sellCount: number;
  total: number;
  netFlow: number; // buy - sell
}

export interface TransactionFilter {
  tokenId?: number;
  poolId?: number;
  txType?: TransactionType;
  walletAddress?: string;
  startTime?: Date;
  endTime?: Date;
  limit?: number;
}
