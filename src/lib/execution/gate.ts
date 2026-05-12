// Live execution gate evaluator. Reports whether the system would be allowed
// to flip on live orders, based on:
//
//   1. Minimum number of closed paper trades (statistical sample size)
//   2. Positive expected value vs the rules_only baseline
//   3. Maximum drawdown of the BUY-tier equity curve
//   4. N consecutive days of clean broker reconciliation
//   5. The operator's explicit EXECUTION_GATE_MANUALLY_ENABLED flag
//
// IMPORTANT: passing every gate does NOT enable live execution. There is no
// live broker client constructible in this codebase. The gate is purely a
// status readout so the operator can see *whether* the system would be
// production-ready in principle.

export interface GateInputs {
  closedBuyTrades: number;
  buyAvgNet: number | null;
  rulesOnlyAvgNet: number | null;
  maxDrawdownPct: number | null;
  cleanReconDaysCount: number;
  manuallyEnabled: boolean;
}

export interface GateThresholds {
  minSamples: number;
  minNetPnl: number;
  maxDrawdown: number;
  minReconDays: number;
}

export type GateCheckId =
  | 'sample_size'
  | 'beats_rules_baseline'
  | 'drawdown_under_limit'
  | 'reconciliation_clean'
  | 'manually_enabled';

export interface GateCheckResult {
  id: GateCheckId;
  pass: boolean;
  observed: string;
  required: string;
}

export interface ExecutionGateStatus {
  passed: boolean;
  checks: GateCheckResult[];
  // Always false in this codebase. Kept as an explicit field so the operator
  // sees "live: false" everywhere it's mentioned.
  liveExecutionAvailable: false;
}

function pctStr(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '-';
  return `${(value * 100).toFixed(2)}%`;
}

export function evaluateExecutionGate(inputs: GateInputs, thresholds: GateThresholds): ExecutionGateStatus {
  const checks: GateCheckResult[] = [];

  checks.push({
    id: 'sample_size',
    pass: inputs.closedBuyTrades >= thresholds.minSamples,
    observed: `${inputs.closedBuyTrades} closed BUY trades`,
    required: `>= ${thresholds.minSamples}`
  });

  const beatsBaseline = inputs.buyAvgNet != null
    && inputs.rulesOnlyAvgNet != null
    && inputs.buyAvgNet >= thresholds.minNetPnl
    && inputs.buyAvgNet > inputs.rulesOnlyAvgNet;
  checks.push({
    id: 'beats_rules_baseline',
    pass: beatsBaseline,
    observed: `BUY avg ${pctStr(inputs.buyAvgNet)} vs rules ${pctStr(inputs.rulesOnlyAvgNet)}`,
    required: `BUY avg >= ${pctStr(thresholds.minNetPnl)} and > rules baseline`
  });

  checks.push({
    id: 'drawdown_under_limit',
    pass: inputs.maxDrawdownPct != null && inputs.maxDrawdownPct <= thresholds.maxDrawdown,
    observed: `max DD ${pctStr(inputs.maxDrawdownPct)}`,
    required: `<= ${pctStr(thresholds.maxDrawdown)}`
  });

  checks.push({
    id: 'reconciliation_clean',
    pass: inputs.cleanReconDaysCount >= thresholds.minReconDays,
    observed: `${inputs.cleanReconDaysCount} clean recon days`,
    required: `>= ${thresholds.minReconDays}`
  });

  checks.push({
    id: 'manually_enabled',
    pass: inputs.manuallyEnabled,
    observed: inputs.manuallyEnabled ? 'enabled' : 'disabled',
    required: 'EXECUTION_GATE_MANUALLY_ENABLED=true'
  });

  return {
    passed: checks.every((c) => c.pass),
    checks,
    liveExecutionAvailable: false
  };
}

// Compute peak-to-trough drawdown of cumulative net P/L from a daily series.
// Returns 0 if there are no losing periods. Returns null when there's no data
// to compute against.
export function maxDrawdownFromDailyPnl(values: Array<number | null | undefined>): number | null {
  const numeric = values
    .map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0))
    .filter((_, i) => values[i] != null);
  if (numeric.length === 0) return null;
  let cum = 0;
  let peak = 0;
  let dd = 0;
  for (const v of numeric) {
    cum += v;
    if (cum > peak) peak = cum;
    const drop = peak - cum;
    if (drop > dd) dd = drop;
  }
  return dd;
}
