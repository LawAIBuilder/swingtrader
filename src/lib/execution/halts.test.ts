import { describe, expect, it } from 'vitest';
import { evaluateHalts } from './halts';

const limits = {
  maxDailyLossPct: 0.02,
  maxConcurrentPositions: 10,
  staleDataMaxMinutes: 90
};

const baseInputs = {
  todayNetPnl: null as number | null,
  openPaperTradesCount: 0,
  latestScreenerRanAt: null as string | null,
  latestDataDateIso: null as string | null,
  reconciliationMismatchCount: 0,
  polygonNotAuthorized: false
};

describe('evaluateHalts', () => {
  it('returns no halts when everything is within tolerance', () => {
    expect(evaluateHalts(baseInputs, limits)).toEqual([]);
  });

  it('flags daily loss breach', () => {
    const halts = evaluateHalts({ ...baseInputs, todayNetPnl: -0.03 }, limits);
    expect(halts.find((h) => h.id === 'daily_loss_breached')).toBeTruthy();
  });

  it('flags too many concurrent positions', () => {
    const halts = evaluateHalts({ ...baseInputs, openPaperTradesCount: 50 }, limits);
    expect(halts.find((h) => h.id === 'concurrent_positions')).toBeTruthy();
  });

  it('flags stale market data when last screener is too old', () => {
    const tooOld = new Date(Date.now() - 1000 * 60 * 60 * 6).toISOString();
    const halts = evaluateHalts({ ...baseInputs, latestScreenerRanAt: tooOld }, limits);
    expect(halts.find((h) => h.id === 'stale_market_data')).toBeTruthy();
  });

  it('flags reconciliation failure when mismatch count > 0', () => {
    const halts = evaluateHalts({ ...baseInputs, reconciliationMismatchCount: 2 }, limits);
    expect(halts.find((h) => h.id === 'reconciliation_failure')).toBeTruthy();
  });

  it('flags polygon auth failure when present', () => {
    const halts = evaluateHalts({ ...baseInputs, polygonNotAuthorized: true }, limits);
    expect(halts.find((h) => h.id === 'api_auth_failure')).toBeTruthy();
  });
});
