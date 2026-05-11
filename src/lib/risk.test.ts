import { describe, expect, it } from 'vitest';
import { computeSlippage, computeStopAndTarget } from './risk';

describe('risk helpers', () => {
  it('uses the larger of ATR and structure distance', () => {
    const result = computeStopAndTarget(100, 4, 98);
    expect(result.stopDistance).toBe(6);
    expect(result.stopPrice).toBe(94);
    expect(result.targetPrice).toBe(112);
  });

  it('classifies large liquid names at 5 bps slippage', () => {
    const result = computeSlippage({ marketCap: 50_000_000_000, avgDollarVolume20d: 500_000_000 });
    expect(result.modeledSlippageBps).toBe(5);
  });
});
