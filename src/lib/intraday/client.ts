// Intraday quote/bar client. Implementations:
//   - MockIntradayClient (default, dev/CI safe)
//   - AlpacaIntradayClient (when ALPACA_API_KEY_ID + SIP feed are configured)
//
// We intentionally don't ship a real Alpaca/Databento adapter wired up to
// streaming credentials yet. The interface here is the contract any future
// adapter must satisfy so the tick job and simulator never depend on a
// specific vendor.

export interface IntradayQuote {
  ticker: string;
  observedAt: string; // ISO timestamp
  bid: number;
  ask: number;
  lastPrice: number;
}

export interface IntradayClient {
  getQuote(ticker: string): Promise<IntradayQuote | null>;
  getQuotes(tickers: string[]): Promise<IntradayQuote[]>;
}
