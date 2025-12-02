/**
 * Mathematical utility functions for price and market calculations
 */

/**
 * Calculate token price in quote currency using AMM reserves
 * Based on Constant Product Formula: x * y = k
 */
export function calculateTokenPriceFromReserves(
  baseReserve: bigint,
  quoteReserve: bigint,
  baseDecimals: number,
  quoteDecimals: number
): number {
  if (baseReserve === 0n) return 0;

  const adjustedBase = Number(baseReserve) / Math.pow(10, baseDecimals);
  const adjustedQuote = Number(quoteReserve) / Math.pow(10, quoteDecimals);

  return adjustedQuote / adjustedBase;
}

/**
 * Calculate market cap: price × circulating supply
 */
export function calculateMarketCap(
  priceUsd: number,
  circulatingSupply: bigint,
  decimals: number
): number {
  const adjustedSupply = Number(circulatingSupply) / Math.pow(10, decimals);
  return priceUsd * adjustedSupply;
}

/**
 * Calculate FDV (Fully Diluted Valuation): price × total supply
 */
export function calculateFDV(
  priceUsd: number,
  totalSupply: bigint,
  decimals: number
): number {
  const adjustedSupply = Number(totalSupply) / Math.pow(10, decimals);
  return priceUsd * adjustedSupply;
}

/**
 * Calculate top N holders percentage
 */
export function calculateTopNPercentage(
  holderBalances: bigint[],
  totalSupply: bigint,
  n: number = 10
): number {
  if (totalSupply === 0n) return 0;

  const sorted = [...holderBalances].sort((a, b) => Number(b - a));
  const topN = sorted.slice(0, n);
  const topNSum = topN.reduce((sum, balance) => sum + balance, 0n);

  // Calculate percentage with 2 decimal precision
  return Number(topNSum * 10000n / totalSupply) / 100;
}

/**
 * Convert lamports to SOL
 */
export function lamportsToSol(lamports: bigint | number): number {
  return Number(lamports) / 1e9;
}

/**
 * Convert SOL to lamports
 */
export function solToLamports(sol: number): bigint {
  return BigInt(Math.round(sol * 1e9));
}

/**
 * Format large numbers with appropriate suffix (K, M, B, T)
 */
export function formatLargeNumber(num: number): string {
  if (num >= 1e12) return `${(num / 1e12).toFixed(2)}T`;
  if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
  if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
  if (num >= 1e3) return `${(num / 1e3).toFixed(2)}K`;
  return num.toFixed(2);
}

/**
 * Calculate percentage change
 */
export function calculatePercentageChange(
  oldValue: number,
  newValue: number
): number {
  if (oldValue === 0) return newValue === 0 ? 0 : 100;
  return ((newValue - oldValue) / oldValue) * 100;
}

/**
 * Get Orca Whirlpool price from sqrtPriceX64
 */
export function getWhirlpoolPrice(sqrtPriceX64: bigint): number {
  const price = Math.pow(Number(sqrtPriceX64) / Math.pow(2, 64), 2);
  return price;
}

/**
 * Sleep utility
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
