import { describe, expect, it } from 'vitest';
import { evaluateExecutionGate, maxDrawdownFromDailyPnl } from './gate';

const thresholds = {
  minSamples: 100,
  minNetPnl: 0.005,
  maxDrawdown: 0.05,
  minReconDays: 30
};

describe('evaluateExecutionGate', () => {
  it('reports liveExecutionAvailable=false even when every check passes', () => {
    const status = evaluateExecutionGate(
      {
        closedBuyTrades: 200,
        buyAvgNet: 0.01,
        rulesOnlyAvgNet: 0.001,
        maxDrawdownPct: 0.02,
        cleanReconDaysCount: 45,
        manuallyEnabled: true
      },
      thresholds
    );
    expect(status.passed).toBe(true);
    expect(status.liveExecutionAvailable).toBe(false);
  });

  it('fails when sample size is too small', () => {
    const status = evaluateExecutionGate(
      {
        closedBuyTrades: 50,
        buyAvgNet: 0.01,
        rulesOnlyAvgNet: 0.001,
        maxDrawdownPct: 0.02,
        cleanReconDaysCount: 45,
        manuallyEnabled: true
      },
      thresholds
    );
    expect(status.passed).toBe(false);
    expect(status.checks.find((c) => c.id === 'sample_size')?.pass).toBe(false);
  });

  it('fails when buy does not beat rules baseline', () => {
    const status = evaluateExecutionGate(
      {
        closedBuyTrades: 200,
        buyAvgNet: 0.001,
        rulesOnlyAvgNet: 0.005,
        maxDrawdownPct: 0.02,
        cleanReconDaysCount: 45,
        manuallyEnabled: true
      },
      thresholds
    );
    expect(status.passed).toBe(false);
    expect(status.checks.find((c) => c.id === 'beats_rules_baseline')?.pass).toBe(false);
  });

  it('fails when manually enabled flag is off', () => {
    const status = evaluateExecutionGate(
      {
        closedBuyTrades: 200,
        buyAvgNet: 0.01,
        rulesOnlyAvgNet: 0.001,
        maxDrawdownPct: 0.02,
        cleanReconDaysCount: 45,
        manuallyEnabled: false
      },
      thresholds
    );
    expect(status.passed).toBe(false);
    expect(status.checks.find((c) => c.id === 'manually_enabled')?.pass).toBe(false);
  });
});

describe('maxDrawdownFromDailyPnl', () => {
  it('returns null for empty input', () => {
    expect(maxDrawdownFromDailyPnl([])).toBeNull();
  });

  it('returns 0 for monotonic upward series', () => {
    expect(maxDrawdownFromDailyPnl([0.01, 0.005, 0.02])).toBe(0);
  });

  it('captures the worst peak-to-trough drop', () => {
    // Cumulative: 0.05, 0.04, 0.02, 0.05, 0.01
    // Peak = 0.05; max drop from peak is 0.05 - 0.01 = 0.04
    const dd = maxDrawdownFromDailyPnl([0.05, -0.01, -0.02, 0.03, -0.04]);
    expect(dd).toBeCloseTo(0.04, 6);
  });
});
