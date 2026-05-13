import { Card } from '@/components/Card';
import { EmptyState } from '@/components/EmptyState';
import { JsonBlock } from '@/components/JsonBlock';
import { Pill } from '@/components/Pill';
import { deriveSystemState, fetchDashboardData, fetchRecentIntradayTrades } from '@/lib/dashboard/data';
import { env } from '@/lib/env';
import { fetchExecutionStatus } from '@/lib/execution/status';

export const dynamic = 'force-dynamic';

export default async function ExecutionPage() {
  const data = await fetchDashboardData();
  if (!data) {
    return (
      <main className="mx-auto max-w-4xl p-8">
        <Card title="Execution gate">
          <EmptyState title="Supabase not configured." description="Add Supabase env vars to view execution gate status." />
        </Card>
      </main>
    );
  }
  const systemState = deriveSystemState(data.runLogs);
  const [status, intraday] = await Promise.all([
    fetchExecutionStatus(systemState),
    fetchRecentIntradayTrades(10)
  ]);

  const queryErrors = Object.entries(status.errors);

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      {queryErrors.length > 0 ? (
        <Card title="Execution-status query errors" subtitle="Some inputs to the gate failed to load. The gate's verdict treats those as zero-evidence.">
          <ul className="space-y-1 text-xs font-mono text-rose-800">
            {queryErrors.map(([view, msg]) => (
              <li key={view}>
                <span className="font-semibold">{view}</span>: {msg}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      <Card
        title="Live execution gate"
        subtitle="Reports whether the system would be allowed to flip on live orders. Live orders are unconditionally disabled in this build."
        action={
          <Pill tone={status.gate.passed ? 'success' : 'warning'}>
            {status.gate.passed ? 'all checks passed' : 'gate not yet passed'}
          </Pill>
        }
      >
        <div className="rounded border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          Live execution is unavailable. Even with every check passed, no live broker client exists in this codebase.
        </div>
        <div className="mt-4 table-wrap">
          <table>
            <thead>
              <tr>
                <th>Check</th>
                <th>Status</th>
                <th>Observed</th>
                <th>Required</th>
              </tr>
            </thead>
            <tbody>
              {status.gate.checks.map((c) => (
                <tr key={c.id}>
                  <td className="font-mono text-xs">{c.id}</td>
                  <td>
                    {c.pass ? (
                      <Pill tone="success">pass</Pill>
                    ) : (
                      <Pill tone="warning">fail</Pill>
                    )}
                  </td>
                  <td className="text-sm">{c.observed}</td>
                  <td className="text-xs text-slate-500">{c.required}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card
        title="Hard halts"
        subtitle="Runtime conditions that would block live orders even with the gate passed. Advisory only in this build."
        action={<Pill tone={status.halts.length === 0 ? 'success' : 'danger'}>{status.halts.length} active</Pill>}
      >
        {status.halts.length === 0 ? (
          <EmptyState title="No active halts." description="Configured limits are within tolerance." />
        ) : (
          <ul className="space-y-2">
            {status.halts.map((h) => (
              <li key={h.id} className="rounded border border-rose-200 bg-rose-50 p-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-rose-900">
                  <Pill tone="danger">{h.id}</Pill>
                  <span>{h.observed}</span>
                </div>
                <p className="mt-1 text-xs text-rose-800">{h.description}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Broker mode" subtitle={`BROKER_MODE=${status.brokerMode}`}>
        <div className="text-sm text-slate-700">
          {status.brokerMode === 'disabled' ? (
            <p>Broker mode is <code>disabled</code>. The DisabledBrokerClient throws on every operation. No order can reach a network call.</p>
          ) : (
            <p>Broker mode is <code>paper</code>. Orders go to Alpaca paper (or the in-memory mock if no Alpaca key is set). No live route exists.</p>
          )}
          <p className="mt-2 text-xs text-slate-500">
            Recent intraday paper trades: {intraday.length}.
            Cancel-all: <code>POST /api/broker/cancel-all</code> with Authorization: Bearer $CRON_SECRET.
          </p>
        </div>
      </Card>

      <Card title="Configured thresholds" subtitle="Read-only view of the env-derived gate and halt settings.">
        <JsonBlock value={{ gate: env.executionGate, halt: env.haltLimits }} />
      </Card>
    </main>
  );
}
