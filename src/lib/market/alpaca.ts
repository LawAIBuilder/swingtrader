import { env, requireEnv } from '@/lib/env';
import { timedFetch } from '@/lib/utils/timed-fetch';
import type { DailyBar } from '@/types/app';

interface AlpacaBarsResponse {
  bars?: Array<{
    t: string;
    o: number;
    h: number;
    l: number;
    c: number;
    v: number;
    vw?: number;
    n?: number;
  }>;
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/$/, '');
}

export class AlpacaDataClient {
  private readonly baseUrl: string;
  private readonly keyId: string;
  private readonly secretKey: string;

  constructor() {
    this.baseUrl = normalizeBaseUrl(env.alpacaDataBaseUrl);
    this.keyId = requireEnv('ALPACA_API_KEY_ID', env.alpacaApiKeyId);
    this.secretKey = requireEnv('ALPACA_API_SECRET_KEY', env.alpacaApiSecretKey);
  }

  async getTickerDailyBars(ticker: string, start: string, end: string): Promise<DailyBar[]> {
    const url = new URL(`${this.baseUrl}/v2/stocks/${encodeURIComponent(ticker)}/bars`);
    url.searchParams.set('timeframe', '1Day');
    url.searchParams.set('start', `${start}T00:00:00Z`);
    url.searchParams.set('end', `${end}T23:59:59Z`);
    url.searchParams.set('adjustment', 'all');
    url.searchParams.set('feed', 'iex');

    const res = await timedFetch(url, {
      headers: {
        accept: 'application/json',
        'APCA-API-KEY-ID': this.keyId,
        'APCA-API-SECRET-KEY': this.secretKey
      },
      timeoutMs: env.fetchTimeoutMs
    });
    if (!res.ok) throw new Error(`Alpaca bars failed ${res.status}: ${res.statusText}`);
    const json = (await res.json()) as AlpacaBarsResponse;
    return (json.bars ?? []).map((b) => ({
      ticker,
      date: b.t.slice(0, 10),
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
      volume: b.v,
      vwap: b.vw ?? null,
      transactions: b.n ?? null
    }));
  }
}
