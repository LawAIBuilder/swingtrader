import type { IntradayClient } from './client';
import { MockIntradayClient } from './mock';

let cached: IntradayClient | null = null;

export type IntradayProviderName = 'mock' | 'alpaca' | 'databento';

export function getIntradayClient(): IntradayClient {
  if (cached) return cached;
  // Real Alpaca / Databento implementations would dispatch on env here.
  // Until those exist, mock is the only safe default and is what the tick
  // job uses for forward simulation.
  cached = new MockIntradayClient();
  return cached;
}
