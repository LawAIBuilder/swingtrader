// Hard halt framework. Halts are runtime conditions that, if active, would
// prevent live order placement even when the execution gate has otherwise
// passed. They are computed from current system state on every dashboard
// load. Live execution is unconditionally disabled in this codebase, so
// halts are advisory only — they tell the operator whether the system would
// be considered safe to flip on.
//
// Halt ids:
//   * daily_loss_breached     - cumulative net P/L today below -HALT_MAX_DAILY_LOSS_PCT
//   * concurrent_positions    - more open paper trades than HALT_MAX_CONCURRENT_POSITIONS
//   * stale_market_data       - latest screener data date older than HALT_STALE_DATA_MAX_MINUTES
//   * reconciliation_failure  - any broker_orders row with reconciliation_status=mismatch or orphan_local
//   * api_auth_failure        - latest screener run details contain POLYGON_NOT_AUTHORIZED

export type HaltId =
  | 'daily_loss_breached'
  | 'concurrent_positions'
  | 'stale_market_data'
  | 'reconciliation_failure'
  | 'api_auth_failure';

export interface ActiveHalt {
  id: HaltId;
  observed: string;
  description: string;
}

export interface HaltInputs {
  todayNetPnl: number | null;
  openPaperTradesCount: number;
  latestScreenerRanAt: string | null;
  latestDataDateIso: string | null;
  reconciliationMismatchCount: number;
  polygonNotAuthorized: boolean;
}

export interface HaltLimits {
  maxDailyLossPct: number;
  maxConcurrentPositions: number;
  staleDataMaxMinutes: number;
}

export function evaluateHalts(inputs: HaltInputs, limits: HaltLimits): ActiveHalt[] {
  const halts: ActiveHalt[] = [];

  if (inputs.todayNetPnl != null && inputs.todayNetPnl < -limits.maxDailyLossPct) {
    halts.push({
      id: 'daily_loss_breached',
      observed: `today net ${(inputs.todayNetPnl * 100).toFixed(2)}%`,
      description: `Daily loss exceeds HALT_MAX_DAILY_LOSS_PCT=${(limits.maxDailyLossPct * 100).toFixed(2)}%`
    });
  }

  if (inputs.openPaperTradesCount > limits.maxConcurrentPositions) {
    halts.push({
      id: 'concurrent_positions',
      observed: `${inputs.openPaperTradesCount} open paper trades`,
      description: `Open positions exceed HALT_MAX_CONCURRENT_POSITIONS=${limits.maxConcurrentPositions}`
    });
  }

  if (inputs.latestScreenerRanAt) {
    const ageMinutes = (Date.now() - new Date(inputs.latestScreenerRanAt).getTime()) / 60_000;
    if (ageMinutes > limits.staleDataMaxMinutes) {
      halts.push({
        id: 'stale_market_data',
        observed: `last screener ${Math.round(ageMinutes)} minutes ago`,
        description: `Screener has not run for ${limits.staleDataMaxMinutes} minutes`
      });
    }
  }

  if (inputs.reconciliationMismatchCount > 0) {
    halts.push({
      id: 'reconciliation_failure',
      observed: `${inputs.reconciliationMismatchCount} mismatched broker orders`,
      description: 'Reconciliation has at least one mismatch or orphan_local row'
    });
  }

  if (inputs.polygonNotAuthorized) {
    halts.push({
      id: 'api_auth_failure',
      observed: 'POLYGON_NOT_AUTHORIZED in latest screener',
      description: 'Polygon API rejected current-day grouped bars; paid plan likely required'
    });
  }

  return halts;
}
