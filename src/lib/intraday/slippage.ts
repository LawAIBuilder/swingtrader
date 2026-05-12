import type { IntradayQuote } from './client';

// Quote-aware slippage model. For each side of a trade we charge:
//   half-spread + a fixed liquidity premium derived from the quoted spread.
//
// This is intentionally simple. A market-impact model would be overkill at
// these size assumptions (paper, retail-scale). The point is to prevent the
// "couple cents" strategy from looking free in backtest by ignoring the
// round-trip cost.

export interface SpreadInfo {
  spreadAbs: number;
  spreadBps: number;
  midPrice: number;
}

export function computeSpread(quote: IntradayQuote): SpreadInfo {
  const mid = (quote.bid + quote.ask) / 2;
  const spreadAbs = Math.max(0, quote.ask - quote.bid);
  return {
    spreadAbs,
    spreadBps: mid > 0 ? Math.round((spreadAbs / mid) * 10_000) : 0,
    midPrice: mid
  };
}

export interface SlippageDecision {
  // Whether the spread is tight enough to be worth executing on a paper basis.
  acceptable: boolean;
  spreadBps: number;
  // Round-trip slippage in bps. Includes both half-spreads and a small
  // adverse-fill cushion (10 bps default) for queue position assumptions.
  roundTripSlippageBps: number;
  // Recommended fill price for a paper buy (ask + half adverse fill cushion).
  paperBuyFill: number;
  // Recommended fill price for a paper sell (bid - half adverse fill cushion).
  paperSellFill: number;
  reason: string;
}

export interface SlippageOptions {
  maxSpreadBps: number;
  // Adverse fill bps applied to each side of the round-trip. Default 5 bps
  // (0.05% per side, 10 bps round trip) which is conservative for liquid US
  // equities and aggressive for small-cap names.
  adverseFillBpsPerSide?: number;
}

export function decideSlippage(quote: IntradayQuote, options: SlippageOptions): SlippageDecision {
  const spread = computeSpread(quote);
  const adverseBps = options.adverseFillBpsPerSide ?? 5;
  const adverseAbsPerSide = (adverseBps / 10_000) * spread.midPrice;

  if (spread.spreadBps > options.maxSpreadBps) {
    return {
      acceptable: false,
      spreadBps: spread.spreadBps,
      roundTripSlippageBps: spread.spreadBps + adverseBps * 2,
      paperBuyFill: quote.ask,
      paperSellFill: quote.bid,
      reason: `spread_too_wide:${spread.spreadBps}bps>${options.maxSpreadBps}`
    };
  }

  return {
    acceptable: true,
    spreadBps: spread.spreadBps,
    roundTripSlippageBps: spread.spreadBps + adverseBps * 2,
    paperBuyFill: Number((quote.ask + adverseAbsPerSide).toFixed(4)),
    paperSellFill: Number((quote.bid - adverseAbsPerSide).toFixed(4)),
    reason: 'spread_ok'
  };
}
