import type { IntradayClient, IntradayQuote } from './client';
import { computeSpread, decideSlippage } from './slippage';

// Returns the age of the quote in seconds. Negative values (clock skew where
// the provider's clock is ahead of ours) clamp to 0 because we cannot decide
// they're "fresh" — they're just unparseable. Anything we can't interpret as
// a recent quote we treat as stale.
export function quoteAgeSeconds(quote: IntradayQuote, nowMs: number = Date.now()): number {
  const t = Date.parse(quote.observedAt);
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  const ageMs = nowMs - t;
  if (ageMs < 0) return 0;
  return Math.floor(ageMs / 1000);
}

export function isQuoteStale(quote: IntradayQuote, maxAgeSeconds: number, nowMs?: number): boolean {
  return quoteAgeSeconds(quote, nowMs) > maxAgeSeconds;
}

// Intraday entry policy. Intentionally conservative: we only open an intraday
// paper position when (a) the most recent quote has a tight enough spread
// per our slippage model, and (b) the prospective stop distance from the
// quoted ask is wide enough that round-trip slippage cannot eat the entire
// risk budget.
//
// Stops/targets here are NOT the same as the EOD swing risk model. Intraday
// is a much shorter horizon, so we use a percent-of-price stop with a 2:1
// reward/risk target sized off the same percent. The goal is to get a
// realistic paper P&L stream — not to replace the EOD model.

export interface IntradayEntryDecision {
  shouldEnter: boolean;
  reason: string;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  spreadBpsAtEntry: number;
  modeledSlippageBps: number;
}

export interface IntradayEntryOptions {
  // Stop distance as a fraction of entry price. 0.005 = 50 bps.
  stopPctOfPrice?: number;
  // Reward/risk multiple used to derive the target from the stop distance.
  rewardRiskMultiple?: number;
  // Maximum acceptable round-trip slippage as a fraction of the stop distance
  // in bps. If round-trip slippage > stop distance * this, we refuse to enter
  // because a single round trip can blow through the stop.
  maxSlippageToStopRatio?: number;
  maxSpreadBps: number;
  // Quotes older than this are rejected. Defaults to 60s.
  maxQuoteAgeSeconds?: number;
  // Test seam: override "now" for deterministic stale-quote testing.
  nowMs?: number;
}

export function decideIntradayEntry(quote: IntradayQuote, options: IntradayEntryOptions): IntradayEntryDecision {
  const stopPct = options.stopPctOfPrice ?? 0.005;
  const rewardRisk = options.rewardRiskMultiple ?? 2;
  const maxSlipRatio = options.maxSlippageToStopRatio ?? 0.5;
  const maxAge = options.maxQuoteAgeSeconds ?? 60;

  const spread = computeSpread(quote);
  const slippage = decideSlippage(quote, { maxSpreadBps: options.maxSpreadBps });
  const entryPrice = slippage.paperBuyFill;
  const stopDistance = entryPrice * stopPct;
  const stopPrice = entryPrice - stopDistance;
  const targetPrice = entryPrice + stopDistance * rewardRisk;

  // Stale-quote rejection BEFORE slippage check so a hung provider can never
  // produce a "good spread" on a multi-minute-old snapshot. The check is
  // deliberately strict because intraday entries depend on price freshness.
  const ageSec = quoteAgeSeconds(quote, options.nowMs);
  if (ageSec > maxAge) {
    return {
      shouldEnter: false,
      reason: `stale_quote:${ageSec}s>${maxAge}s`,
      entryPrice,
      stopPrice,
      targetPrice,
      spreadBpsAtEntry: spread.spreadBps,
      modeledSlippageBps: slippage.roundTripSlippageBps
    };
  }

  if (!slippage.acceptable) {
    return {
      shouldEnter: false,
      reason: slippage.reason,
      entryPrice,
      stopPrice,
      targetPrice,
      spreadBpsAtEntry: spread.spreadBps,
      modeledSlippageBps: slippage.roundTripSlippageBps
    };
  }

  const slipPctOfPrice = slippage.roundTripSlippageBps / 10_000;
  if (slipPctOfPrice > stopPct * maxSlipRatio) {
    return {
      shouldEnter: false,
      reason: `slippage_dominates_stop:${slippage.roundTripSlippageBps}bps>${Math.round(stopPct * maxSlipRatio * 10_000)}bps`,
      entryPrice,
      stopPrice,
      targetPrice,
      spreadBpsAtEntry: spread.spreadBps,
      modeledSlippageBps: slippage.roundTripSlippageBps
    };
  }

  return {
    shouldEnter: true,
    reason: 'ok',
    entryPrice,
    stopPrice,
    targetPrice,
    spreadBpsAtEntry: spread.spreadBps,
    modeledSlippageBps: slippage.roundTripSlippageBps
  };
}

export interface OpenIntradayTradeArgs {
  ticker: string;
  source: string; // 'eod_swing_buy' | 'manual' | etc.
  client: IntradayClient;
  options: IntradayEntryOptions;
}

export interface OpenIntradayTradeOutcome {
  opened: boolean;
  reason: string;
  decision: IntradayEntryDecision | null;
  quote: IntradayQuote | null;
}

// Pure helper used by the tick job and tests. Does not write to Supabase
// itself so it is straightforward to unit test.
export async function evaluateOpenIntradayTrade(args: OpenIntradayTradeArgs): Promise<OpenIntradayTradeOutcome> {
  const quote = await args.client.getQuote(args.ticker);
  if (!quote) {
    return { opened: false, reason: 'no_quote', decision: null, quote: null };
  }
  const decision = decideIntradayEntry(quote, args.options);
  return {
    opened: decision.shouldEnter,
    reason: decision.reason,
    decision,
    quote
  };
}
