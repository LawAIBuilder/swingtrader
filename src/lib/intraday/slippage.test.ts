import { describe, expect, it } from 'vitest';
import type { IntradayQuote } from './client';
import { computeSpread, decideSlippage } from './slippage';

function quote(bid: number, ask: number, last = (bid + ask) / 2): IntradayQuote {
  return {
    ticker: 'TEST',
    observedAt: '2026-05-11T15:30:00Z',
    bid,
    ask,
    lastPrice: last
  };
}

describe('computeSpread', () => {
  it('returns spread in bps from a quote', () => {
    const s = computeSpread(quote(99.95, 100.05));
    expect(s.midPrice).toBeCloseTo(100, 5);
    expect(s.spreadAbs).toBeCloseTo(0.1, 5);
    expect(s.spreadBps).toBe(10);
  });

  it('floors negative spreads at zero', () => {
    const s = computeSpread(quote(100.1, 99.9));
    expect(s.spreadAbs).toBe(0);
  });
});

describe('decideSlippage', () => {
  it('accepts tight spreads with adverse fill cushion', () => {
    const d = decideSlippage(quote(99.98, 100.02), { maxSpreadBps: 50 });
    expect(d.acceptable).toBe(true);
    expect(d.paperBuyFill).toBeGreaterThan(100.02);
    expect(d.paperSellFill).toBeLessThan(99.98);
    expect(d.reason).toBe('spread_ok');
  });

  it('rejects when spread exceeds the configured max', () => {
    const d = decideSlippage(quote(99.0, 101.0), { maxSpreadBps: 50 });
    expect(d.acceptable).toBe(false);
    expect(d.reason).toMatch(/spread_too_wide/);
  });

  it('reports round-trip slippage including both half-spreads', () => {
    const d = decideSlippage(quote(99.95, 100.05), { maxSpreadBps: 50, adverseFillBpsPerSide: 5 });
    expect(d.spreadBps).toBe(10);
    expect(d.roundTripSlippageBps).toBe(20);
  });
});
