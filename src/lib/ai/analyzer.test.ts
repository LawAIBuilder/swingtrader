import { describe, expect, it } from 'vitest';
import { passForBudgetExhausted, syntheticAnalysisForDisposition } from './analyzer';

describe('syntheticAnalysisForDisposition', () => {
  it('marks BLACKOUT cases with the right thesis', () => {
    const r = syntheticAnalysisForDisposition('BLACKOUT', ['earnings_blackout:keyword_fallback']);
    expect(r.output.tier).toBe('AVOID');
    expect(r.output.thesis).toMatch(/earnings blackout/);
    expect(r.output.risk_flags).toContain('blackout');
    expect(r.estimatedCostUsd).toBe(0);
    expect(r.modelName).toBe('preflag-rules');
  });

  it('marks AVOID cases (offering) with selloff_type=offering', () => {
    const r = syntheticAnalysisForDisposition('AVOID', ['offering:edgar_424B5']);
    expect(r.output.tier).toBe('AVOID');
    expect(r.output.selloff_type).toBe('offering');
  });

  it('marks AVOID cases without offering as selloff_type=unknown', () => {
    const r = syntheticAnalysisForDisposition('AVOID', ['liquidity_not_ok']);
    expect(r.output.selloff_type).toBe('unknown');
  });
});

describe('passForBudgetExhausted', () => {
  it('returns tier=PASS (not AVOID) so the row stays a non-trade', () => {
    const r = passForBudgetExhausted(['ok_signal']);
    expect(r.output.tier).toBe('PASS');
  });

  it('flags the budget reason in risk_flags', () => {
    const r = passForBudgetExhausted(['ok_signal']);
    expect(r.output.risk_flags).toContain('ai_budget_exhausted');
    expect(r.output.risk_flags).toContain('ok_signal');
  });

  it('costs nothing and uses the budget-fallback model name', () => {
    const r = passForBudgetExhausted([]);
    expect(r.estimatedCostUsd).toBe(0);
    expect(r.tokensUsed).toBe(0);
    expect(r.modelName).toBe('budget-fallback');
  });

  it('signals low confidence (we did not actually look)', () => {
    const r = passForBudgetExhausted([]);
    expect(r.output.confidence_in_tier).toBe('low');
  });

  it('produces schema-valid output', () => {
    const r = passForBudgetExhausted([]);
    expect(r.schemaValid).toBe(true);
  });
});
