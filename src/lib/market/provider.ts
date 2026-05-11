import { env } from '@/lib/env';
import type { MarketDataClient } from './client';
import { MockMarketDataClient } from './mock';
import { PolygonClient } from './polygon';

let cached: MarketDataClient | null = null;

export function getMarketDataClient(): MarketDataClient {
  if (cached) return cached;
  if (env.mockMarketData || !env.polygonApiKey) {
    cached = new MockMarketDataClient();
    return cached;
  }
  if (env.marketDataProvider !== 'polygon') {
    throw new Error(`Unsupported MARKET_DATA_PROVIDER=${env.marketDataProvider}. MVP broad screening currently supports polygon or mock.`);
  }
  cached = new PolygonClient();
  return cached;
}
