import { env } from '@/lib/env';
import { AlpacaPaperBrokerClient } from './alpaca';
import type { BrokerClient } from './client';
import { DisabledBrokerClient } from './disabled';
import { MockBrokerClient } from './mock';

let cached: BrokerClient | null = null;
let cachedKey: string | null = null;

function buildClient(): BrokerClient {
  if (env.brokerMode === 'disabled') return new DisabledBrokerClient();
  // BROKER_MODE=paper: prefer Alpaca paper if credentials are present;
  // otherwise fall back to MockBroker so the tick + reconciliation pipelines
  // still execute end-to-end in dev.
  if (env.alpacaApiKeyId && env.alpacaApiSecretKey) {
    try {
      return new AlpacaPaperBrokerClient();
    } catch {
      return new MockBrokerClient();
    }
  }
  return new MockBrokerClient();
}

export function getBrokerClient(): BrokerClient {
  const key = `${env.brokerMode}:${env.alpacaApiKeyId ?? ''}:${env.alpacaPaperBaseUrl}`;
  if (!cached || cachedKey !== key) {
    cached = buildClient();
    cachedKey = key;
  }
  return cached;
}

export function _resetBrokerClientForTests(client: BrokerClient | null = null): void {
  cached = client;
  cachedKey = client ? '__test__' : null;
}
