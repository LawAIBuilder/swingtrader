import { AiCostPanel } from '@/components/AiCostPanel';
import { Card } from '@/components/Card';
import { CandidateTable, ClosedTradesList, OpenTradesList } from '@/components/CandidateRow';
import { EmptyState } from '@/components/EmptyState';
import { IntradayTradesList } from '@/components/IntradayTradesList';
import { Pill } from '@/components/Pill';
import { RunLogTable } from '@/components/RunLogTable';
import { SummariesPanel } from '@/components/SummariesPanel';
import { SystemStatus } from '@/components/SystemStatus';
import { env } from '@/lib/env';
import {
  deriveSystemState,
  fetchAiCostDaily,
  fetchDashboardData,
  fetchPromptStats,
  fetchRecentDailySummaries,
  fetchRecentIntradayTrades
} from '@/lib/dashboard/data';
import { pct } from '@/lib/utils/numbers';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const [data, summaries, aiCost, promptStats, intraday] = await Promise.all([
    fetchDashboardData(),
    fetchRecentDailySummaries(5),
    fetchAiCostDaily(14),
    fetchPromptStats(),
    fetchRecentIntradayTrades(25)
  ]);

  if (!data) {
    return (
      <main className="mx-auto max-w-4xl p-8">
        <Card title="Setup needed">
          <p className="text-slate-700">
            Add Supabase env vars (<code>NEXT_PUBLIC_SUPABASE_URL</code>,{' '}
            <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code>), apply{' '}
            <code>supabase/schema.sql</code>, then restart the app. See{' '}
            <code>README.md</code> for the staged production rollout.
          </p>
        </Card>
      </main>
    );
  }

  const state = deriveSystemState(data.runLogs);
  const totalClosed = data.tierStats.reduce((sum, r) => sum + Number(r.closed_trades ?? 0), 0);
  const buyStats = data.tierStats.find((r) => r.group_key === 'BUY');
  const recentRunLogs = data.runLogs.slice(0, 10);

  const noWritesYet = data.runLogs.length === 0;
  const todayCandidates = data.todayCandidates;
  const latestScreenDate = todayCandidates[0]?.screen_date;

  const viewErrors = Object.entries(data.errors);
  return (
    <main className="mx-auto max-w-7xl space-y-6 p-6">
      <SystemStatus state={state} />

      {viewErrors.length > 0 ? (
        <Card title="Supabase view errors" subtitle="Some dashboard panels failed to load. The rest still rendered.">
          <ul className="space-y-1 text-xs font-mono text-rose-800">
            {viewErrors.map(([view, msg]) => (
              <li key={view}>
                <span className="font-semibold">{view}</span>: {msg}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <div className="grid gap-4 md:grid-cols-4">
        <Card density="compact">
          <div className="text-xs uppercase tracking-wide text-slate-500">Today candidates</div>
          <div className="mt-1 text-3xl font-semibold">{todayCandidates.length}</div>
          <div className="mt-1 text-xs text-slate-500">{latestScreenDate ? `screen_date=${latestScreenDate}` : 'no screen yet'}</div>
        </Card>
        <Card density="compact">
          <div className="text-xs uppercase tracking-wide text-slate-500">Open paper trades</div>
          <div className="mt-1 text-3xl font-semibold">{data.openTrades.length}</div>
        </Card>
        <Card density="compact">
          <div className="text-xs uppercase tracking-wide text-slate-500">Closed trades</div>
          <div className="mt-1 text-3xl font-semibold">{totalClosed}</div>
        </Card>
        <Card density="compact">
          <div className="text-xs uppercase tracking-wide text-slate-500">BUY avg net</div>
          <div className="mt-1 text-3xl font-semibold">{pct(buyStats?.avg_pnl_net)}</div>
          <div className="mt-1 text-xs text-slate-500">{buyStats?.closed_trades ?? 0} closed</div>
        </Card>
      </div>

      <Card title="Recent job runs" subtitle="Last 10 cron / manual triggers. Expand a row for full payload.">
        {noWritesYet ? (
          <EmptyState
            title="App deployed, no jobs have run yet."
            description="Manually trigger /api/jobs/screener with the cron secret, or wait for the cron schedule."
            hint={<span>See <code>README.md → Operational runbook</code> for the curl example.</span>}
          />
        ) : (
          <RunLogTable rows={recentRunLogs} />
        )}
      </Card>

      <Card
        title="Today's candidates"
        subtitle={latestScreenDate ? `screen_date=${latestScreenDate}` : 'no screen has produced candidates yet'}
      >
        {todayCandidates.length === 0 ? (
          <EmptyState
            title="No candidates for the latest screen date."
            description="Either the screener has not produced rows yet, or every candidate was filtered out by pre-flags."
            hint="Check the latest screener run above for diagnostics."
          />
        ) : (
          <CandidateTable rows={todayCandidates} />
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Open trades" subtitle={`${data.openTrades.length} open`}>
          {data.openTrades.length === 0 ? (
            <EmptyState title="No open paper trades." />
          ) : (
            <OpenTradesList rows={data.openTrades} />
          )}
        </Card>

        <Card title="Recent closed trades" subtitle={`${data.recentClosed.length} most recent exits`}>
          {data.recentClosed.length === 0 ? (
            <EmptyState title="No closed trades yet." />
          ) : (
            <ClosedTradesList rows={data.recentClosed} />
          )}
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Stats by tier" subtitle="Paper-only outcomes. Sample sizes shown.">
          <StatsTable rows={data.tierStats} />
        </Card>
        <Card title="Stats by screen" subtitle="Paper-only outcomes by screen source.">
          <StatsTable rows={data.screenStats} />
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="AI spend (recent)" subtitle="Estimated cost across real Anthropic calls. Mock and pre-flag rows excluded.">
          <AiCostPanel rows={aiCost} />
        </Card>
        <Card title="Stats by prompt version" subtitle="Closed-trade outcomes grouped by paper_trades.prompt_version.">
          <StatsTable rows={promptStats} />
        </Card>
      </div>

      <Card
        title="Intraday paper trades"
        subtitle={`TRADING_MODE=${env.tradingMode.join(',')} • ${intraday.length} recent`}
        action={env.tradingMode.includes('intraday_paper') ? (
          <Pill tone="paper">Active</Pill>
        ) : (
          <Pill tone="neutral">Disabled</Pill>
        )}
      >
        {intraday.length === 0 ? (
          <EmptyState
            title="No intraday paper trades yet."
            description={
              env.tradingMode.includes('intraday_paper')
                ? 'The intraday_tick job will open trades for today\u2019s BUY tier when spread is tight enough.'
                : 'Set TRADING_MODE=eod_swing,intraday_paper and schedule the /api/jobs/intraday route to enable.'
            }
          />
        ) : (
          <IntradayTradesList rows={intraday} />
        )}
      </Card>

      <Card title="Recent daily summaries" subtitle="Persisted markdown snapshots from the daily_summary job.">
        <SummariesPanel rows={summaries} />
      </Card>
    </main>
  );
}

function StatsTable({ rows }: { rows: import('@/lib/dashboard/data').StatRow[] }) {
  if (rows.length === 0) {
    return <EmptyState title="No closed trades yet." description="Stats appear once the outcome tracker closes some trades." />;
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Group</th>
            <th>Closed</th>
            <th>Win rate</th>
            <th>Avg net</th>
            <th>Avg gross</th>
            <th>Ambiguous</th>
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
