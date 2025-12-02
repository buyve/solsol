import { config } from './index.js';

export const shyftConfig = {
  // REST API configuration
  rest: {
    baseUrl: 'https://api.shyft.to/sol/v1',
    defiBaseUrl: 'https://defi.shyft.to/v0',
    apiKey: config.shyft.apiKey,
    network: 'mainnet-beta' as const,
  },

  // gRPC configuration
  grpc: {
    endpoint: config.shyft.grpcEndpoint,
    token: config.shyft.grpcToken,
  },

  // Rate limiting
  rateLimit: {
    requestsPerSecond: 10,
    burstLimit: 20,
  },

  // Retry configuration
  retry: {
    maxRetries: 3,
    initialDelayMs: 1000,
    maxDelayMs: 10000,
  },
} as const;

export const SHYFT_ENDPOINTS = {
  // Token endpoints
  tokenInfo: '/token/get_info',
  tokenHolders: '/token/get_holders',
  tokenBalance: '/wallet/token_balance',

  // DeFi endpoints
  poolsByToken: '/pools/get_by_token',
  poolInfo: '/pools/get_by_pair',
} as const;

export function buildRestUrl(endpoint: string, params: Record<string, string> = {}): string {
  const url = new URL(`${shyftConfig.rest.baseUrl}${endpoint}`);
  url.searchParams.set('network', shyftConfig.rest.network);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  return url.toString();
}

export function buildDefiUrl(endpoint: string, params: Record<string, string> = {}): string {
  const url = new URL(`${shyftConfig.rest.defiBaseUrl}${endpoint}`);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  return url.toString();
}

export function getShyftHeaders(): Record<string, string> {
  return {
    'x-api-key': shyftConfig.rest.apiKey,
    'Content-Type': 'application/json',
  };
}
