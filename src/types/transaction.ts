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

export type TransactionType = 'buy' | 'sell' | 'create' | 'add_liquidity' | 'remove_liquidity';

export interface TransactionCreate {
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

export interface VolumeStats {
  id: number;
  tokenId: number;
  volume24hSol: number;
  volume24hUsd: number;
  buyCount24h: number;
  sellCount24h: number;
  buyVolume24hSol: number;
  sellVolume24hSol: number;
  timestamp: Date;
}

export interface Volume24h {
  buyVolume: number;
  sellVolume: number;
  buyCount: number;
  sellCount: number;
  totalVolume: number;
}

export interface SwapEvent {
  signature: string;
  mint: string;
  poolAddress: string;
  txType: TransactionType;
  wallet: string;
  amountToken: bigint;
  amountSol: bigint;
  timestamp: number;
  slot: number;
}
