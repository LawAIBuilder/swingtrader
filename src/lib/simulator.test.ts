import { describe, expect, it } from 'vitest';
import { simulateTradeDay } from './simulator';
import type { DailyBar, FinalizedPaperTrade } from '@/types/app';

const trade: FinalizedPaperTrade = {
  id: 1,
  candidate_id: 1,
  analysis_id: 1,
  effective_tier: 'BUY',
  ticker: 'MOCK',
  screen_source: 'screen_a',
  prompt_version: 'v1.0',
  entry_mode: 'next_day_open',
  signal_date: '2026-04-30',
  entry_date: '2026-05-01',
  entry_price: 100,
  atr14: 3,
  signal_day_low: 96,
  stop_price: 94,
  target_price: 112,
  modeled_slippage_bps: 10,
  liquidity_bucket: 'large_liquid',
  status: 'open',
  exit_date: null,
  exit_price: null,
  exit_reason: null,
  had_ambiguous_day: false,
  pnl_pct_gross: null,
  pnl_pct_net: null
};

function bar(partial: Partial<DailyBar>): DailyBar {
  return {
    ticker: 'MOCK',
    date: '2026-05-04',
    open: 100,
    high: 105,
    low: 98,
    close: 102,
    volume: 1000000,
    ...partial
  };
}

describe('simulateTradeDay', () => {
  it('uses conservative stop when daily bar touches both target and stop', () => {
    const result = simulateTradeDay(trade, bar({ high: 113, low: 93, open: 100 }), 1);
    expect(result.isAmbiguous).toBe(true);
    expect(result.exitNow).toBe(true);
    expect(result.exitReason).toBe('stop_conservative');
    expect(result.exitPrice).toBe(94);
  });

  it('handles gap target before stop', () => {
    const result = simulateTradeDay(trade, bar({ open: 115, high: 116, low: 93 }), 1);
    expect(result.isAmbiguous).toBe(true);
    expect(result.exitReason).toBe('gap_target');
    expect(result.status).toBe('target_hit');
  });

  it('time-closes at configured day five', () => {
    const result = simulateTradeDay(trade, bar({ high: 108, low: 96, close: 101 }), 5);
    expect(result.exitNow).toBe(true);
    expect(result.exitReason).toBe('time_stop');
  });
});
