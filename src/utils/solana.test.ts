import { describe, it, expect } from 'vitest';
import {
  isValidSolanaAddress,
  shortenAddress,
  getProgramName,
  KNOWN_PROGRAMS,
  TOKEN_MINTS,
  signatureToBase58,
} from './solana.js';

describe('solana utilities', () => {
  describe('isValidSolanaAddress', () => {
    it('should validate correct Solana addresses', () => {
      // Valid base58 encoded public key
      expect(isValidSolanaAddress(TOKEN_MINTS.SOL)).toBe(true);
      expect(isValidSolanaAddress(TOKEN_MINTS.USDC)).toBe(true);
      expect(isValidSolanaAddress(KNOWN_PROGRAMS.SYSTEM_PROGRAM)).toBe(true);
    });

    it('should reject invalid addresses', () => {
      expect(isValidSolanaAddress('')).toBe(false);
      expect(isValidSolanaAddress('invalid')).toBe(false);
      expect(isValidSolanaAddress('0x1234567890abcdef')).toBe(false);
      // Invalid base58 character (0, O, I, l are not in base58)
      expect(isValidSolanaAddress('0000000000000000000000000000000000000000000')).toBe(false);
    });
  });

  describe('shortenAddress', () => {
    it('should shorten addresses correctly', () => {
      const address = 'So11111111111111111111111111111111111111112';
      expect(shortenAddress(address)).toBe('So11...1112');
      expect(shortenAddress(address, 6)).toBe('So1111...111112');
    });
  });

  describe('getProgramName', () => {
    it('should return program name for known addresses', () => {
      expect(getProgramName(KNOWN_PROGRAMS.PUMPFUN)).toBe('PUMPFUN');
      expect(getProgramName(KNOWN_PROGRAMS.RAYDIUM_AMM_V4)).toBe('RAYDIUM_AMM_V4');
      expect(getProgramName(KNOWN_PROGRAMS.TOKEN_PROGRAM)).toBe('TOKEN_PROGRAM');
    });

    it('should return null for unknown addresses', () => {
      expect(getProgramName('unknown_address_12345678901234567890')).toBe(null);
      expect(getProgramName('')).toBe(null);
    });
  });

  describe('KNOWN_PROGRAMS', () => {
    it('should have valid program addresses', () => {
      for (const [name, address] of Object.entries(KNOWN_PROGRAMS)) {
        expect(isValidSolanaAddress(address), `${name} should be a valid address`).toBe(true);
      }
    });
  });

  describe('TOKEN_MINTS', () => {
    it('should have valid token mint addresses', () => {
      for (const [name, address] of Object.entries(TOKEN_MINTS)) {
        expect(isValidSolanaAddress(address), `${name} should be a valid address`).toBe(true);
      }
    });
  });

  describe('signatureToBase58', () => {
    it('should encode signature bytes to base58', () => {
      // 64-byte signature
      const signature = new Uint8Array(64).fill(1);
      const encoded = signatureToBase58(signature);
      expect(encoded).toBeTruthy();
      expect(encoded.length).toBeGreaterThan(0);
    });

    it('should handle empty bytes', () => {
      const result = signatureToBase58(new Uint8Array(0));
      expect(result).toBe('');
    });

    it('should produce consistent results', () => {
      const signature = Buffer.from('test'.repeat(16)); // 64 bytes
      const result1 = signatureToBase58(signature);
      const result2 = signatureToBase58(signature);
      expect(result1).toBe(result2);
    });
  });
});
