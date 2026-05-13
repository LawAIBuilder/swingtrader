import { Card } from '@/components/Card';
import { Pill } from '@/components/Pill';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

// Operator runbook page. Surfaces every manual recovery curl in one place so
// the on-call doesn't have to dig through README sections at 2am. We never
// echo CRON_SECRET into the page; the operator pastes it inline at copy time.
//
// Intentionally read-only: no buttons that POST. Click-fire would create a
// new authentication surface and we don't want a logged-in admin email to
// double as a cron-equivalent role.

interface Action {
  title: string;
  description: string;
  curl: string;
  destructive?: boolean;
}

const baseUrl = env.appBaseUrl.replace(/\/$/, '');

const screenerActions: Action[] = [
  {
    title: 'Force-rerun the screener for today',
    description:
      'Use when a scheduled screener tick aborted (skipped, locked, or raised). force=true supersedes any in-flight running run for the same date and reruns from scratch.',
    curl: `curl -X POST '${baseUrl}/api/jobs/screener?force=true' \\
  -H 'Authorization: Bearer $CRON_SECRET'`
  },
  {
    title: 'Backfill the screener for a specific date',
    description:
      'Replay the screener against historical bars (only meaningful with MARKET_DATA_FRESHNESS_MODE=latest_available). Date is YYYY-MM-DD.',
    curl: `curl -X POST '${baseUrl}/api/jobs/screener?runDate=YYYY-MM-DD&force=true' \\
  -H 'Authorization: Bearer $CRON_SECRET'`
  }
];

const outcomeActions: Action[] = [
  {
    title: 'Force-rerun the outcome tracker',
    description:
      'Re-evaluates open paper trades against the most recent bars. Idempotent - already-closed trades are not re-opened.',
    curl: `curl -X POST '${baseUrl}/api/jobs/outcomes?force=true' \\
  -H 'Authorization: Bearer $CRON_SECRET'`
  }
];

const reconActions: Action[] = [
  {
    title: 'Force-rerun broker reconciliation',
    description:
      'Reconciles broker (Alpaca paper) orders + positions against our local view. Each stage is independent; one failure does not block the other.',
    curl: `curl -X POST '${baseUrl}/api/jobs/broker-recon?force=true' \\
  -H 'Authorization: Bearer $CRON_SECRET'`
  },
  {
    title: 'Cancel ALL open broker orders',
    description:
      'Last-resort kill switch. Sends an admin cancel to Alpaca paper. Only meaningful when BROKER_MODE=paper. There is no live broker in this build.',
    curl: `curl -X POST '${baseUrl}/api/broker/cancel-all' \\
  -H 'Authorization: Bearer $CRON_SECRET'`,
    destructive: true
  }
];

const summaryActions: Action[] = [
  {
    title: 'Re-send daily summary email for today',
    description:
      'Idempotent for the same runDate (one email per UTC date). Skips if Resend is not configured.',
    curl: `curl -X POST '${baseUrl}/api/jobs/summary?force=true' \\
  -H 'Authorization: Bearer $CRON_SECRET'`
  }
];

const retentionActions: Action[] = [
  {
    title: 'Run retention sweep now',
    description:
      'Prunes run_logs older than 90d and intraday_progression older than 30d. Safe to run any time; runs weekly on the cron schedule otherwise.',
    curl: `curl -X POST '${baseUrl}/api/jobs/retention?force=true' \\
  -H 'Authorization: Bearer $CRON_SECRET'`
  }
];

const debugActions: Action[] = [
  {
    title: 'Liveness ping',
    description: 'Cheapest probe. No DB hit, no env introspection. Returns plain "ok".',
    curl: `curl '${baseUrl}/api/ping'`
  },
  {
    title: 'Full health snapshot',
    description: 'Includes DB liveness, breaker state, deploy commit, and config presence flags. Never returns a secret value.',
    curl: `curl '${baseUrl}/api/health'`
  }
];

function ActionRow({ action }: { action: Action }) {
  return (
    <div className="space-y-1.5 rounded-md border border-slate-200 bg-white p-3 text-sm">
      <div className="flex items-center gap-2">
        <span className="font-medium text-slate-900">{action.title}</span>
        {action.destructive ? <Pill tone="danger">destructive</Pill> : null}
      </div>
      <p className="text-xs text-slate-600">{action.description}</p>
      <pre className="overflow-x-auto rounded bg-slate-900 p-2 font-mono text-xs text-slate-100">{action.curl}</pre>
    </div>
  );
}

function Section({ title, actions }: { title: string; actions: Action[] }) {
  return (
    <Card title={title}>
      <div className="space-y-2">
        {actions.map((a) => (
          <ActionRow key={a.title} action={a} />
        ))}
      </div>
    </Card>
  );
}

export default function OpsPage() {
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Operator runbook</h1>
        <p className="mt-1 text-sm text-slate-500">
          Manual recovery curls. Set <code>CRON_SECRET</code> in your shell first
          (<code>export CRON_SECRET=&apos;…&apos;</code>) — none of these commands
          echo the secret into the page. The base URL is read from{' '}
          <code>APP_BASE_URL</code>, currently <code>{baseUrl}</code>.
        </p>
      </header>

      <Card title="Run-lock state machine, in plain English">
        <ul className="space-y-1 text-sm text-slate-700">
          <li>
            Each <code>(jobName, runDate)</code> pair lives in <code>run_logs</code>{' '}
            with a single status: <code>running</code>, <code>success</code>,{' '}
            <code>failed</code>, <code>skipped</code>, or <code>superseded</code>.
          </li>
          <li>
            A new request with no <code>force=true</code> is rejected with HTTP{' '}
            <code>409</code> if a <code>running</code> row exists for the same key
            within <code>RUN_LOCK_TTL_MS</code>. Older rows are reaped as crashed.
          </li>
          <li>
            <code>force=true</code> demotes any prior <code>running</code> row to{' '}
            <code>superseded</code> and acquires a fresh lock. The old run can no
            longer write its terminal status because the lock token differs.
          </li>
          <li>
            On uncaught throw, the lock is released to status <code>failed</code>{' '}
            with the error message in <code>details.error</code>. Visit{' '}
            <code>/runs</code> to see the table.
          </li>
        </ul>
      </Card>

      <Section title="Screener" actions={screenerActions} />
      <Section title="Outcome tracker" actions={outcomeActions} />
      <Section title="Broker reconciliation" actions={reconActions} />
      <Section title="Daily summary email" actions={summaryActions} />
      <Section title="Retention" actions={retentionActions} />
      <Section title="Debug / probes" actions={debugActions} />

      <Card title="Other surfaces">
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
          <li>
            <code>/runs</code> — last 50 runs, expandable for the full{' '}
            <code>details</code> JSON.
          </li>
          <li>
            <code>/execution</code> — gate status + halt switches. Read-only;
            execution is gated on closed-trade sample size and recon coverage.
          </li>
          <li>
            <code>/settings</code> — read-only env introspection (no secret
            values, only presence flags).
          </li>
        </ul>
      </Card>
    </main>
  );
}
