import { Card } from '@/components/Card';
import { EmptyState } from '@/components/EmptyState';
import { BarChart, LineChart } from '@/components/MiniChart';
import {
  fetchBaselineStats,
  fetchCandidatesPerDay,
  fetchDashboardData,
  fetchDispositionStats,
  fetchPnlPerDay,
  fetchPromptStats,
  fetchSectorStats,
  fetchSelloffStats,
  type StatRow
} from '@/lib/dashboard/data';
import { hasPublicSupabaseConfig } from '@/lib/env';
import { pct } from '@/lib/utils/numbers';

export const dynamic = 'force-dynamic';

function StatsTable({ rows, label }: { rows: StatRow[]; label: string }) {
  if (rows.length === 0) {
    return <EmptyState title={`No closed trades for ${label} yet.`} description="Stats appear once outcomes settle." />;
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{label}</th>
            <th>Closed</th>
            <th>Win rate</th>
            <th>Avg net</th>
            <th>Avg gross</th>
            <th>Ambig.</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.group_key}>
              <td className="font-semibold">{r.group_key}</td>
              <td>{r.closed_trades}</td>
              <td>{pct(r.win_rate)}</td>
              <td className={Number(r.avg_pnl_net ?? 0) >= 0 ? 'text-emerald-700' : 'text-rose-700'}>
                {pct(r.avg_pnl_net)}
              </td>
              <td className="text-slate-500">{pct(r.avg_pnl_gross)}</td>
              <td>{pct(r.ambiguous_rate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function AnalyticsPage() {
  if (!hasPublicSupabaseConfig()) {
    return (
      <main className="mx-auto max-w-4xl p-6">
        <Card title="Setup needed">
          <p className="text-sm text-slate-700">Configure Supabase env vars to view analytics.</p>
        </Card>
      </main>
    );
  }

  const [data, candidates, pnl, sector, selloff, disposition, prompt, baseline] = await Promise.all([
    fetchDashboardData(),
    fetchCandidatesPerDay(60),
    fetchPnlPerDay(60),
    fetchSectorStats(),
    fetchSelloffStats(),
    fetchDispositionStats(),
    fetchPromptStats(),
    fetchBaselineStats()
  ]);

  // Per-day series come back DESC. Reverse for chronological charting.
  const candidatesAsc = [...candidates].reverse();
  const pnlAsc = [...pnl].reverse();
  const equityCurve = pnlAsc.reduce<{ label: string; value: number }[]>((acc, row) => {
    const prev = acc.length === 0 ? 0 : acc[acc.length - 1].value;
    acc.push({ label: row.day, value: prev + Number(row.sum_pnl_net ?? 0) });
    return acc;
  }, []);

  return (
    <main className="mx-auto max-w-7xl space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Analytics</h1>
        <p className="mt-1 text-sm text-slate-500">
          Paper-only outcomes. Sample sizes are usually small early; treat
          everything below as descriptive, not statistically significant. A
          bootstrap-CI / cluster-bootstrap pass is deferred until enough closed
          trades exist.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Candidates per day" subtitle="From bounce_trader.v_candidates_per_day">
          <BarChart points={candidatesAsc.map((r) => ({ label: r.day, value: Number(r.candidates ?? 0) }))} />
        </Card>
        <Card title="Daily sum P/L (net)" subtitle="From bounce_trader.v_pnl_per_day">
          <BarChart points={pnlAsc.map((r) => ({ label: r.day, value: Number(r.sum_pnl_net ?? 0) }))} color="#16a34a" />
        </Card>
        <Card title="Cumulative net P/L" subtitle="Sum of daily net P/L over time">
          <LineChart points={equityCurve} color="#0f172a" />
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="By tier" subtitle="From bounce_trader.v_basic_stats_by_tier">
          <StatsTable rows={data?.tierStats ?? []} label="Tier" />
        </Card>
        <Card title="By screen" subtitle="From bounce_trader.v_basic_stats_by_screen">
          <StatsTable rows={data?.screenStats ?? []} label="Screen" />
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="By selloff type" subtitle="Joined via analyses.selloff_type">
          <StatsTable rows={selloff} label="Selloff" />
        </Card>
        <Card title="By sector" subtitle="From candidates.sector">
          <StatsTable rows={sector} label="Sector" />
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="By pre-flag disposition" subtitle="OK_FOR_AI / AVOID / BLACKOUT outcomes">
          <StatsTable rows={disposition} label="Disposition" />
        </Card>
        <Card title="By prompt version" subtitle="Outcomes grouped by paper_trades.prompt_version">
          <StatsTable rows={prompt} label="Prompt" />
        </Card>
      </div>

      <Card
        title="Baselines"
        subtitle="Counterfactual paper trades populated by the screener for every candidate (buy_all) or only when pre-flags pass (rules_only)."
      >
        <StatsTable rows={baseline} label="Baseline" />
        <p className="mt-3 text-xs text-slate-500">
          SPY and sector benchmarks are deferred until a per-candidate benchmark
          fetch exists. The baseline_kind column is open so additional
          counterfactuals can be added without altering the table.
        </p>
      </Card>
    </main>
  );
}
