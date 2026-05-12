import { describe, expect, it } from 'vitest';
import type { IntradayQuote } from './client';
import { decideIntradayEntry, evaluateOpenIntradayTrade, isQuoteStale, quoteAgeSeconds } from './entry';

const REF_OBSERVED_AT = '2026-05-11T15:30:00Z';
const REF_NOW_MS = Date.parse(REF_OBSERVED_AT);

function quote(bid: number, ask: number, ticker = 'TEST', observedAt = REF_OBSERVED_AT): IntradayQuote {
  return {
    ticker,
    observedAt,
    bid,
    ask,
    lastPrice: (bid + ask) / 2
  };
}

describe('decideIntradayEntry', () => {
  it('opens a position when spread is tight and stop is wide enough', () => {
    const d = decideIntradayEntry(quote(99.99, 100.01), {
      maxSpreadBps: 50,
      stopPctOfPrice: 0.01,
      rewardRiskMultiple: 2,
      maxSlippageToStopRatio: 0.5,
      nowMs: REF_NOW_MS
    });
    expect(d.shouldEnter).toBe(true);
    expect(d.entryPrice).toBeGreaterThan(100);
    expect(d.stopPrice).toBeLessThan(d.entryPrice);
    expect(d.targetPrice - d.entryPrice).toBeCloseTo(2 * (d.entryPrice - d.stopPrice), 4);
  });

  it('refuses to enter when spread is wider than allowed', () => {
    const d = decideIntradayEntry(quote(99, 101), { maxSpreadBps: 50, nowMs: REF_NOW_MS });
    expect(d.shouldEnter).toBe(false);
    expect(d.reason).toMatch(/spread_too_wide/);
  });

  it('refuses when round-trip slippage would dominate the stop', () => {
    // 50 bps stop with default 5 bps per side cushion + a 30 bps spread = 40 bps round trip,
    // which exceeds 50 * 0.5 = 25 bps slip budget.
    const d = decideIntradayEntry(quote(99.85, 100.15), {
      maxSpreadBps: 100,
      stopPctOfPrice: 0.005,
      maxSlippageToStopRatio: 0.5,
      nowMs: REF_NOW_MS
    });
    expect(d.shouldEnter).toBe(false);
    expect(d.reason).toMatch(/slippage_dominates_stop/);
  });

  it('refuses to enter when the quote is older than maxQuoteAgeSeconds', () => {
    const d = decideIntradayEntry(quote(99.99, 100.01), {
      maxSpreadBps: 50,
      stopPctOfPrice: 0.01,
      maxQuoteAgeSeconds: 60,
      nowMs: REF_NOW_MS + 5 * 60 * 1000 // 5 minutes after observedAt
    });
    expect(d.shouldEnter).toBe(false);
    expect(d.reason).toMatch(/^stale_quote:/);
  });
});

describe('quoteAgeSeconds / isQuoteStale', () => {
  it('returns 0 for clock skew (provider clock ahead of ours)', () => {
    expect(quoteAgeSeconds(quote(100, 100.01), REF_NOW_MS - 5_000)).toBe(0);
  });
  it('returns Infinity for unparseable observedAt', () => {
    const q = { ...quote(100, 100.01), observedAt: 'not-a-date' };
    expect(quoteAgeSeconds(q, REF_NOW_MS)).toBe(Number.POSITIVE_INFINITY);
  });
  it('flags quotes older than the threshold', () => {
    const q = quote(100, 100.01, 'X', '2026-05-11T15:00:00Z');
    expect(isQuoteStale(q, 60, REF_NOW_MS)).toBe(true);
  });
  it('accepts fresh quotes', () => {
    expect(isQuoteStale(quote(100, 100.01), 60, REF_NOW_MS + 5_000)).toBe(false);
  });
});

describe('evaluateOpenIntradayTrade', () => {
  it('returns no_quote when client returns null', async () => {
    const out = await evaluateOpenIntradayTrade({
      ticker: 'TEST',
      source: 'manual',
      client: { getQuote: async () => null, getQuotes: async () => [] },
      options: { maxSpreadBps: 50, nowMs: REF_NOW_MS }
    });
    expect(out.opened).toBe(false);
    expect(out.reason).toBe('no_quote');
  });

  it('returns the entry decision when quote is present', async () => {
    const q = quote(99.99, 100.01);
    const out = await evaluateOpenIntradayTrade({
      ticker: 'TEST',
      source: 'manual',
      client: { getQuote: async () => q, getQuotes: async () => [q] },
      options: {
        maxSpreadBps: 50,
        stopPctOfPrice: 0.01,
        maxSlippageToStopRatio: 0.5,
        nowMs: REF_NOW_MS
      }
    });
    expect(out.opened).toBe(true);
    expect(out.decision?.entryPrice).toBeGreaterThan(0);
  });
});
