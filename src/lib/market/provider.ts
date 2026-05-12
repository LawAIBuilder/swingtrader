import { env } from '@/lib/env';
import type { MarketDataClient } from './client';
import { MockMarketDataClient } from './mock';
import { PolygonClient } from './polygon';

export type MarketProviderName = 'mock' | 'polygon';

export interface MarketProviderInfo {
  // Resolved provider, after taking MOCK_MARKET_DATA and missing-key fallbacks
  // into account. This is what the dashboard should display, not the raw env.
  name: MarketProviderName;
  // Raw value of MARKET_DATA_PROVIDER env. May differ from `name` (e.g. user
  // configured polygon but no API key was set, so we silently fell back to
  // mock). We expose both so the UI can surface the discrepancy.
  configured: string;
  baseUrl: string | null;
  apiKeyConfigured: boolean;
  reason: string;
}

let cached: MarketDataClient | null = null;

function resolveProvider(): { name: MarketProviderName; reason: string } {
  if (env.mockMarketData) return { name: 'mock', reason: 'MOCK_MARKET_DATA=true' };
  if (!env.polygonApiKey) return { name: 'mock', reason: 'POLYGON_API_KEY missing; falling back to mock' };
  if (env.marketDataProvider !== 'polygon') {
    throw new Error(`Unsupported MARKET_DATA_PROVIDER=${env.marketDataProvider}. MVP broad screening currently supports polygon or mock.`);
  }
  return { name: 'polygon', reason: 'MARKET_DATA_PROVIDER=polygon with POLYGON_API_KEY set' };
}

export function getMarketDataClient(): MarketDataClient {
  if (cached) return cached;
  const resolved = resolveProvider();
  cached = resolved.name === 'polygon' ? new PolygonClient() : new MockMarketDataClient();
  return cached;
}

export function getMarketDataProviderInfo(): MarketProviderInfo {
  const resolved = resolveProvider();
  return {
    name: resolved.name,
    configured: env.marketDataProvider,
    baseUrl: resolved.name === 'polygon' ? env.polygonBaseUrl : null,
    apiKeyConfigured: Boolean(env.polygonApiKey),
    reason: resolved.reason
  };
}

// Reset hook for tests so the cached client doesn't leak across cases that
// override env between runs. Production never calls this.
export function _resetMarketDataClientCacheForTests(): void {
  cached = null;
}
