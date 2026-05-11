import { Card } from '@/components/Card';
import { StatusBadge } from '@/components/StatusBadge';
import { hasPublicSupabaseConfig } from '@/lib/env';
import { getSupabasePublic } from '@/lib/supabase/public';
import { compactNumber, money, pct, pctAlready } from '@/lib/utils/numbers';

export const dynamic = 'force-dynamic';

type AnyRow = Record<string, any>;

async function getDashboardData() {
  if (!hasPublicSupabaseConfig()) return null;
  // The dashboard reads via the anon key against RLS-restricted views in the
  // bounce_trader schema. This is the only Supabase usage on the Vercel side;
  // the service role key never reaches the browser deployment.
  const supabase = getSupabasePublic();
  const [todayRun, openTrades, recentClosed, tierStats, screenStats, runLogs] = await Promise.all([
    supabase.from('v_dashboard_today_candidates').select('*').limit(100),
    supabase.from('v_dashboard_open_trades').select('*').limit(100),
    supabase.from('v_dashboard_recent_closed_trades').select('*').limit(100),
    supabase.from('v_basic_stats_by_tier').select('*').order('group_key'),
    supabase.from('v_basic_stats_by_screen').select('*').order('group_key'),
    supabase.from('v_recent_run_logs').select('*').limit(10)
  ]);

  for (const result of [todayRun, openTrades, recentClosed, tierStats, screenStats, runLogs]) {
    if (result.error) throw result.error;
  }

  return {
    todayRun: (todayRun.data ?? []) as AnyRow[],
    openTrades: (openTrades.data ?? []) as AnyRow[],
    recentClosed: (recentClosed.data ?? []) as AnyRow[],
    tierStats: (tierStats.data ?? []) as AnyRow[],
    screenStats: (screenStats.data ?? []) as AnyRow[],
    runLogs: (runLogs.data ?? []) as AnyRow[]
  };
}

export default async function HomePage() {
  const data = await getDashboardData();

  if (!data) {
    return (
      <main className="mx-auto max-w-4xl p-8">
        <Card title="Setup needed">
          <p className="text-slate-700">Add Supabase env vars, run <code>supabase/schema.sql</code>, then restart the app.</p>
        </Card>
      </main>
    );
  }

  const totalClosed = data.tierStats.reduce((sum, r) => sum + Number(r.closed_trades ?? 0), 0);
  const buyStats = data.tierStats.find((r) => r.group_key === 'BUY');

  return (
    <main className="mx-auto max-w-7xl space-y-6 p-6">
      <header className="flex flex-col justify-between gap-3 md:flex-row md:items-end">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Bounce Trader MVP</h1>
          <p className="mt-1 text-slate-600">Paper-only forward tracker. No live trading code is enabled in this repo.</p>
        </div>
        <div className="text-sm text-slate-500">Refreshes on page load</div>
      </header>

      <div className="grid gap-4 md:grid-cols-4">
        <Card><div className="text-sm text-slate-500">Today candidates</div><div className="mt-2 text-3xl font-bold">{data.todayRun.length}</div></Card>
        <Card><div className="text-sm text-slate-500">Open paper trades</div><div className="mt-2 text-3xl font-bold">{data.openTrades.length}</div></Card>
        <Card><div className="text-sm text-slate-500">Closed trades</div><div className="mt-2 text-3xl font-bold">{totalClosed}</div></Card>
        <Card><div className="text-sm text-slate-500">BUY avg net</div><div className="mt-2 text-3xl font-bold">{pct(buyStats?.avg_pnl_net)}</div></Card>
      </div>

      <Card title="Today's candidates">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Ticker</th><th>Screen</th><th>Tier</th><th>Change</th><th>Rel vol</th><th>Price</th><th>Mkt cap</th><th>Sector</th><th>Thesis</th></tr></thead>
            <tbody>
              {data.todayRun.map((r) => (
                <tr key={`${r.ticker}-${r.screen_source}`}>
                  <td className="font-semibold">{r.ticker}</td>
                  <td>{r.screen_source}</td>
                  <td><StatusBadge value={r.effective_tier ?? r.ai_tier} /></td>
                  <td>{pctAlready(r.pct_change)}</td>
                  <td>{Number(r.rel_volume ?? 0).toFixed(2)}x</td>
                  <td>{money(r.price)}</td>
                  <td>{compactNumber(r.market_cap)}</td>
                  <td>{r.sector ?? '-'}</td>
                  <td className="max-w-md whitespace-normal text-sm text-slate-600">{r.thesis ?? '-'}</td>
                </tr>
              ))}
              {data.todayRun.length === 0 ? <tr><td colSpan={9} className="text-slate-500">No candidates for the latest screen date.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Open trades">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Ticker</th><th>Tier</th><th>Entry</th><th>Stop</th><th>Target</th><th>Day</th></tr></thead>
              <tbody>
                {data.openTrades.map((r) => (
                  <tr key={r.id}>
                    <td className="font-semibold">{r.ticker}</td>
                    <td><StatusBadge value={r.effective_tier} /></td>
                    <td>{money(r.entry_price)}</td>
                    <td>{money(r.stop_price)}</td>
                    <td>{money(r.target_price)}</td>
                    <td>{r.days_open ?? '-'}</td>
                  </tr>
                ))}
                {data.openTrades.length === 0 ? <tr><td colSpan={6} className="text-slate-500">No open paper trades.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Recent closed trades">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Ticker</th><th>Tier</th><th>Exit</th><th>Reason</th><th>Net</th></tr></thead>
              <tbody>
                {data.recentClosed.map((r) => (
                  <tr key={r.id}>
                    <td className="font-semibold">{r.ticker}</td>
                    <td><StatusBadge value={r.effective_tier} /></td>
                    <td>{r.exit_date}</td>
                    <td>{r.exit_reason}</td>
                    <td>{pct(r.pnl_pct_net)}</td>
                  </tr>
                ))}
                {data.recentClosed.length === 0 ? <tr><td colSpan={5} className="text-slate-500">No closed trades yet.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Stats by tier">
          <StatsTable rows={data.tierStats} />
        </Card>
        <Card title="Stats by screen">
          <StatsTable rows={data.screenStats} />
        </Card>
      </div>

      <Card title="Recent job logs">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Ran at</th><th>Job</th><th>Status</th><th>Details</th></tr></thead>
            <tbody>
              {data.runLogs.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.ran_at).toLocaleString()}</td>
                  <td>{r.job_name}</td>
                  <td><StatusBadge value={r.status} /></td>
                  <td className="max-w-lg whitespace-normal text-xs text-slate-600"><pre>{JSON.stringify(r.details ?? {}, null, 2)}</pre></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </main>
  );
}

function StatsTable({ rows }: { rows: AnyRow[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Group</th><th>Closed</th><th>Win rate</th><th>Avg net</th><th>Ambiguous</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.group_key}>
              <td className="font-semibold">{r.group_key}</td>
              <td>{r.closed_trades}</td>
              <td>{pct(r.win_rate)}</td>
              <td>{pct(r.avg_pnl_net)}</td>
              <td>{pct(r.ambiguous_rate)}</td>
            </tr>
          ))}
          {rows.length === 0 ? <tr><td colSpan={5} className="text-slate-500">No closed trades yet.</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}
