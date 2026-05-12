import type { IntradayClient, IntradayQuote } from './client';

// Deterministic mock for development and CI. Generates a stable bid/ask
// around a base price for each ticker so unit tests can lock in behavior
// without running the network.

function basePrice(ticker: string): number {
  let s = 0;
  for (const c of ticker) s = (s + c.charCodeAt(0)) | 0;
  return 30 + (s % 200);
}

export class MockIntradayClient implements IntradayClient {
  async getQuote(ticker: string): Promise<IntradayQuote> {
    const base = basePrice(ticker);
    // Walk the price slowly with the wall clock so successive ticks differ.
    const drift = ((Date.now() / 60_000) % 30) - 15;
    const last = Math.max(1, base + drift / 10);
    const halfSpread = Math.max(0.01, last * 0.0008); // 8 bps half-spread default
    return {
      ticker,
      observedAt: new Date().toISOString(),
      bid: Number((last - halfSpread).toFixed(4)),
      ask: Number((last + halfSpread).toFixed(4)),
      lastPrice: Number(last.toFixed(4))
    };
  }

  async getQuotes(tickers: string[]): Promise<IntradayQuote[]> {
    return Promise.all(tickers.map((t) => this.getQuote(t)));
  }
}
