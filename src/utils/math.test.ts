import { describe, it, expect } from 'vitest';
import {
  calculateTokenPriceFromReserves,
  calculateMarketCap,
  calculateFDV,
  calculateTopNPercentage,
  lamportsToSol,
  solToLamports,
  formatLargeNumber,
  calculatePercentageChange,
  getWhirlpoolPrice,
} from './math.js';

describe('math utilities', () => {
  describe('calculateTokenPriceFromReserves', () => {
    it('should calculate price from AMM reserves', () => {
      // 1 billion base tokens with 6 decimals, 1000 SOL with 9 decimals
      const baseReserve = 1_000_000_000_000_000n; // 1B tokens
      const quoteReserve = 1_000_000_000_000n; // 1000 SOL
      const price = calculateTokenPriceFromReserves(baseReserve, quoteReserve, 6, 9);
      expect(price).toBeCloseTo(0.001); // 0.001 SOL per token
    });

    it('should return 0 for zero base reserve', () => {
      const price = calculateTokenPriceFromReserves(0n, 1000n, 6, 9);
      expect(price).toBe(0);
    });
  });

  describe('calculateMarketCap', () => {
    it('should calculate market cap correctly', () => {
      const priceUsd = 0.0001; // $0.0001 per token
      const supply = 1_000_000_000_000_000n; // 1 billion tokens with 6 decimals
      const mcap = calculateMarketCap(priceUsd, supply, 6);
      expect(mcap).toBeCloseTo(100_000); // $100k market cap
    });
  });

  describe('calculateFDV', () => {
    it('should calculate FDV correctly', () => {
      const priceUsd = 0.0001;
      const totalSupply = 10_000_000_000_000_000n; // 10 billion tokens
      const fdv = calculateFDV(priceUsd, totalSupply, 6);
      expect(fdv).toBeCloseTo(1_000_000); // $1M FDV
    });
  });

  describe('calculateTopNPercentage', () => {
    it('should calculate top N holders percentage', () => {
      const balances = [100n, 50n, 30n, 10n, 5n, 3n, 2n];
      const totalSupply = 200n;
      const topNPercent = calculateTopNPercentage(balances, totalSupply, 3);
      // Top 3: 100 + 50 + 30 = 180, which is 90% of 200
      expect(topNPercent).toBe(90);
    });

    it('should return 0 for zero total supply', () => {
      const result = calculateTopNPercentage([100n, 50n], 0n, 2);
      expect(result).toBe(0);
    });

    it('should handle when N is larger than holders list', () => {
      const balances = [100n, 50n];
      const totalSupply = 200n;
      const result = calculateTopNPercentage(balances, totalSupply, 10);
      expect(result).toBe(75); // 150/200 = 75%
    });
  });

  describe('lamportsToSol / solToLamports', () => {
    it('should convert lamports to SOL', () => {
      expect(lamportsToSol(1_000_000_000n)).toBe(1);
      expect(lamportsToSol(500_000_000)).toBe(0.5);
      expect(lamportsToSol(1_000_000)).toBe(0.001);
    });

    it('should convert SOL to lamports', () => {
      expect(solToLamports(1)).toBe(1_000_000_000n);
      expect(solToLamports(0.5)).toBe(500_000_000n);
      expect(solToLamports(0.001)).toBe(1_000_000n);
    });

    it('should be reversible', () => {
      const originalSol = 2.5;
      const lamports = solToLamports(originalSol);
      const backToSol = lamportsToSol(lamports);
      expect(backToSol).toBe(originalSol);
    });
  });

  describe('formatLargeNumber', () => {
    it('should format numbers with appropriate suffix', () => {
      expect(formatLargeNumber(500)).toBe('500.00');
      expect(formatLargeNumber(1_500)).toBe('1.50K');
      expect(formatLargeNumber(1_500_000)).toBe('1.50M');
      expect(formatLargeNumber(1_500_000_000)).toBe('1.50B');
      expect(formatLargeNumber(1_500_000_000_000)).toBe('1.50T');
    });
  });

  describe('calculatePercentageChange', () => {
    it('should calculate percentage change correctly', () => {
      expect(calculatePercentageChange(100, 150)).toBe(50);
      expect(calculatePercentageChange(100, 50)).toBe(-50);
      expect(calculatePercentageChange(100, 100)).toBe(0);
    });

    it('should handle zero old value', () => {
      expect(calculatePercentageChange(0, 100)).toBe(100);
      expect(calculatePercentageChange(0, 0)).toBe(0);
    });
  });

  describe('getWhirlpoolPrice', () => {
    it('should calculate price from sqrtPriceX64', () => {
      // sqrt price of 1 is 2^64
      const sqrtPriceForOne = 18446744073709551616n; // 2^64
      const price = getWhirlpoolPrice(sqrtPriceForOne);
      expect(price).toBeCloseTo(1, 10);
    });
  });
});
