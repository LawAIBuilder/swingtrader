import { hasPublicSupabaseConfig, env } from '@/lib/env';
import { fetchPnlPerDay, type SystemState } from '@/lib/dashboard/data';
import { getSupabasePublic } from '@/lib/supabase/public';
import { getSupabaseAuthBT } from '@/lib/supabase/server';
import { evaluateExecutionGate, maxDrawdownFromDailyPnl, type ExecutionGateStatus } from './gate';
import { evaluateHalts, type ActiveHalt } from './halts';

export interface ExecutionStatus {
  gate: ExecutionGateStatus;
  halts: ActiveHalt[];
  brokerMode: 'disabled' | 'paper';
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

export async function fetchExecutionStatus(systemState: SystemState): Promise<ExecutionStatus> {
  const halts: ActiveHalt[] = [];
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
      brokerMode: env.brokerMode
    };
  }

  const supabase = getSupabasePublic();
  // Authenticated client for RLS-restricted broker_orders reads. If the
  // operator is signed out, this falls back to anon and returns zero rows
  // (cleanReconDays gracefully reports 0).
  const authClient = await getSupabaseAuthBT();
  const [tier, baselines, openTrades, pnlSeries, brokerOrders] = await Promise.all([
    supabase.from('v_basic_stats_by_tier').select('group_key,closed_trades,avg_pnl_net').then((r) => ({
      data: (r.data ?? []) as BasicStatRow[],
      error: r.error
    })),
    supabase.from('v_baseline_stats').select('group_key,avg_pnl_net').then((r) => ({
      data: (r.data ?? []) as BaselineRow[],
      error: r.error
    })),
    supabase.from('paper_trades').select('id', { count: 'exact', head: true }).eq('status', 'open'),
    fetchPnlPerDay(60),
    authClient
      .from('broker_orders')
      .select('reconciliation_status,reconciled_at')
      .order('reconciled_at', { ascending: false })
      .limit(500)
      .then((r) => ({
        data: (r.data ?? []) as BrokerOrderCountRow[],
        error: r.error
      }))
  ]);

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

  return { gate, halts, brokerMode: env.brokerMode };
}
