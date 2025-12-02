/**
 * Calculate token price in SOL using AMM constant product formula
 * x * y = k
 */
export function calculateTokenPriceInSol(
  baseReserve: bigint,
  quoteReserve: bigint,
  baseDecimals: number,
  quoteDecimals: number = 9
): number {
  if (baseReserve === 0n) return 0;

  const adjustedBase = Number(baseReserve) / Math.pow(10, baseDecimals);
  const adjustedQuote = Number(quoteReserve) / Math.pow(10, quoteDecimals);

  return adjustedQuote / adjustedBase;
}

/**
 * Convert price from SOL to USD
 */
export function solToUsd(priceSol: number, solUsdRate: number): number {
  return priceSol * solUsdRate;
}

/**
 * Calculate market cap (price × circulating supply)
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
 * Calculate FDV (price × total supply)
 * For Pump.fun tokens, total supply is fixed at 1B
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
 * Pump.fun fixed supply (1 billion tokens, 6 decimals)
 */
export const PUMPFUN_SUPPLY = BigInt(1_000_000_000 * 1_000_000);
export const PUMPFUN_DECIMALS = 6;

/**
 * Calculate percentage change
 */
export function percentageChange(oldValue: number, newValue: number): number {
  if (oldValue === 0) return newValue === 0 ? 0 : 100;
  return ((newValue - oldValue) / oldValue) * 100;
}

/**
 * Format large numbers for display
 */
export function formatNumber(value: number): string {
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(2)}B`;
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(2)}K`;
  }
  return value.toFixed(2);
}

/**
 * Safely convert bigint to number with decimal adjustment
 */
export function bigintToNumber(value: bigint, decimals: number): number {
  return Number(value) / Math.pow(10, decimals);
}

/**
 * Convert number to bigint with decimal adjustment
 */
export function numberToBigint(value: number, decimals: number): bigint {
  return BigInt(Math.floor(value * Math.pow(10, decimals)));
}
