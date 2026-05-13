import { hasPublicSupabaseConfig, env } from '@/lib/env';
import { fetchPnlPerDay, type SystemState } from '@/lib/dashboard/data';
import { logError } from '@/lib/log';
import { getSupabasePublic } from '@/lib/supabase/public';
import { getSupabaseAuthBT } from '@/lib/supabase/server';
import { evaluateExecutionGate, maxDrawdownFromDailyPnl, type ExecutionGateStatus } from './gate';
import { evaluateHalts, type ActiveHalt } from './halts';

export interface ExecutionStatus {
  gate: ExecutionGateStatus;
  halts: ActiveHalt[];
  brokerMode: 'disabled' | 'paper';
  // View name -> truncated error message. Surfaced inline on /execution so a
  // partial Supabase outage is observable rather than rendered as a wrong
  // gate result. The dashboard treats a non-empty errors map as "treat
  // recon-clean-days as 0 and don't blame the operator".
  errors: Record<string, string>;
}

interface BasicStatRow {
  group_key: string;
  closed_trades: number;
  avg_pnl_net: number | null;
}

interface BaselineRow {
  group_key: string;
  avg_pnl_net: number | null;
}

interface BrokerOrderCountRow {
  reconciliation_status: string;
  reconciled_at: string | null;
}

// Counts the trailing window of consecutive days in which every reconciled
// broker order has reconciliation_status='matched'. A day with zero orders
// counts as clean. Stops counting at the first day with any non-matched row.
function countCleanReconDays(rows: Array<{ day: string; cleanDay: boolean }>): number {
  let count = 0;
  for (const r of rows) {
    if (!r.cleanDay) break;
    count += 1;
  }
  return count;
}

// Defensive promise wrapper. Any thrown supabase call (network, auth)
// becomes an entry in the errors map instead of bubbling out.
//
// supabase-js returns PromiseLike<PostgrestSingleResponse<unknown[]>>; we
// don't have generated DB types for this project so the column types are
// `unknown`. The cast at the boundary is intentional and confined to this
// helper. Callers narrow with their own row interfaces.
async function safeQuery<T>(
  name: string,
  factory: () => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  errors: Record<string, string>,
  fallback: T
): Promise<T> {
  try {
    const r = await factory();
    if (r.error) {
      errors[name] = r.error.message.slice(0, 200);
      return fallback;
    }
    return (r.data as T | null) ?? fallback;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors[name] = msg.slice(0, 200);
    logError('execution_status_query_failed', { view: name, errorMessage: msg.slice(0, 200) });
    return fallback;
  }
}

export async function fetchExecutionStatus(systemState: SystemState): Promise<ExecutionStatus> {
  const halts: ActiveHalt[] = [];
  const errors: Record<string, string> = {};
  const baseHaltInputs = {
    todayNetPnl: null as number | null,
    openPaperTradesCount: 0,
    latestScreenerRanAt: systemState.latestScreener?.ran_at ?? null,
    latestDataDateIso: systemState.latestDataDate ?? null,
    reconciliationMismatchCount: 0,
    polygonNotAuthorized: Boolean(systemState.polygonNotAuthorized)
  };

  if (!hasPublicSupabaseConfig()) {
    const gate = evaluateExecutionGate(
      {
        closedBuyTrades: 0,
        buyAvgNet: null,
        rulesOnlyAvgNet: null,
        maxDrawdownPct: null,
        cleanReconDaysCount: 0,
        manuallyEnabled: env.executionGate.manuallyEnabled
      },
      env.executionGate
    );
    return {
      gate,
      halts: evaluateHalts(baseHaltInputs, env.haltLimits),
      brokerMode: env.brokerMode,
      errors
    };
  }

  const supabase = getSupabasePublic();
  // Authenticated client for RLS-restricted broker_orders reads. If the
  // operator is signed out, this falls back to anon and returns zero rows
  // (cleanReconDays gracefully reports 0).
  const authClient = await getSupabaseAuthBT();

  const [tierData, baselineData, openTradesCountResult, pnlSeries, brokerOrderData] = await Promise.all([
    safeQuery<BasicStatRow[]>(
      'v_basic_stats_by_tier',
      () => supabase.from('v_basic_stats_by_tier').select('group_key,closed_trades,avg_pnl_net'),
      errors,
      []
    ),
    safeQuery<BaselineRow[]>(
      'v_baseline_stats',
      () => supabase.from('v_baseline_stats').select('group_key,avg_pnl_net'),
      errors,
      []
    ),
    (async () => {
      try {
        return await supabase.from('paper_trades').select('id', { count: 'exact', head: true }).eq('status', 'open');
      } catch (err) {
        errors['paper_trades.count'] = err instanceof Error ? err.message.slice(0, 200) : 'unknown';
        return { count: 0, data: null, error: null } as { count: number | null; data: null; error: null };
      }
    })(),
    fetchPnlPerDay(60),
    safeQuery<BrokerOrderCountRow[]>(
      'broker_orders',
      () =>
        authClient
          .from('broker_orders')
          .select('reconciliation_status,reconciled_at')
          .order('reconciled_at', { ascending: false })
          .limit(500),
      errors,
      []
    )
  ]);

  // Re-shape into the "{ data }" wrappers the rest of the function expected
  // so the existing reducer logic keeps working.
  const tier = { data: tierData };
  const baselines = { data: baselineData };
  const openTrades = openTradesCountResult;
  const brokerOrders = { data: brokerOrderData };

  const tierRow = tier.data.find((r) => r.group_key === 'BUY');
  const baselineRow = baselines.data.find((r) => r.group_key === 'rules_only');
  const closedBuyTrades = Number(tierRow?.closed_trades ?? 0);
  const buyAvgNet = tierRow?.avg_pnl_net ?? null;
  const rulesOnlyAvgNet = baselineRow?.avg_pnl_net ?? null;

  const drawdown = maxDrawdownFromDailyPnl(pnlSeries.map((row) => row.sum_pnl_net ?? 0));

  // Group broker orders by date of reconciled_at; a "clean" day is one with
  // zero non-matched rows. We walk most-recent-first.
  const dayMap = new Map<string, boolean>();
  let mismatchCount = 0;
  for (const row of brokerOrders.data) {
    if (row.reconciliation_status !== 'matched' && row.reconciliation_status !== 'pending') {
      mismatchCount += 1;
    }
    if (!row.reconciled_at) continue;
    const day = row.reconciled_at.slice(0, 10);
    const prev = dayMap.get(day);
    const isClean = row.reconciliation_status === 'matched';
    if (prev === undefined) dayMap.set(day, isClean);
    else if (prev && !isClean) dayMap.set(day, false);
  }
  const sortedDays = Array.from(dayMap.entries())
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([day, cleanDay]) => ({ day, cleanDay }));
  const cleanReconDaysCount = countCleanReconDays(sortedDays);

  const todayPnlRow = pnlSeries[0];
  const haltInputs = {
    ...baseHaltInputs,
    todayNetPnl: todayPnlRow?.sum_pnl_net ?? null,
    openPaperTradesCount: openTrades.count ?? 0,
    reconciliationMismatchCount: mismatchCount
  };

  const gate = evaluateExecutionGate(
    {
      closedBuyTrades,
      buyAvgNet,
      rulesOnlyAvgNet,
      maxDrawdownPct: drawdown,
      cleanReconDaysCount,
      manuallyEnabled: env.executionGate.manuallyEnabled
    },
    env.executionGate
  );

  halts.push(...evaluateHalts(haltInputs, env.haltLimits));

  return { gate, halts, brokerMode: env.brokerMode, errors };
}
