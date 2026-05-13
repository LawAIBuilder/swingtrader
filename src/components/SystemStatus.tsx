import type { SystemState } from '@/lib/dashboard/data';
import { Pill } from './Pill';

function formatRelative(iso: string | undefined): string {
  if (!iso) return 'never';
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return iso;
  const delta = Date.now() - ts;
  if (delta < 60_000) return `${Math.max(1, Math.round(delta / 1000))}s ago`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}

function statusTone(status: string | undefined): 'success' | 'warning' | 'danger' | 'neutral' | 'info' {
  if (status === 'success') return 'success';
  if (status === 'partial') return 'warning';
  if (status === 'failed') return 'danger';
  if (status === 'running') return 'info';
  return 'neutral';
}

function StatBlock({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="rounded-lg bg-white px-3 py-2 ring-1 ring-slate-200">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-0.5 text-sm font-medium text-slate-900">{value}</div>
      {sub ? <div className="text-[11px] text-slate-500">{sub}</div> : null}
    </div>
  );
}

export function SystemStatus({ state }: { state: SystemState }) {
  const providerLabel = state.marketProvider === 'polygon'
    ? 'Polygon'
    : state.marketProvider === 'mock'
      ? 'Mock'
      : 'Unknown';
  const providerTone = state.marketProvider === 'polygon' ? 'success' : 'warning';

  const aiTone = state.aiMode === 'anthropic' ? 'success' : 'warning';
  const aiLabel = state.aiMode === 'anthropic' ? 'Anthropic live' : 'Mock AI';

  const freshnessTone = state.freshnessMode === 'same_day_required' ? 'success' : 'warning';
  const freshnessLabel = state.freshnessMode === 'same_day_required' ? 'Same-day required' : 'Latest available';

  return (
    <section className="rounded-xl border border-slate-200 bg-gradient-to-br from-white to-slate-50 p-5 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone="paper" title="No live broker code is enabled">PAPER ONLY</Pill>
        <Pill tone={providerTone} title="Resolved market data provider">Data: {providerLabel}</Pill>
        <Pill tone={aiTone} title="Resolved AI analyzer">AI: {aiLabel}</Pill>
        <Pill tone={freshnessTone} title="MARKET_DATA_FRESHNESS_MODE">Freshness: {freshnessLabel}</Pill>
        <Pill tone="neutral" title="ENTRY_MODE env var">Entry: {state.entryMode}</Pill>
        <Pill tone="neutral" title="PROMPT_VERSION env var">Prompt: {state.promptVersion}</Pill>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2 md:grid-cols-4">
        <StatBlock
          label="Latest data date"
          value={state.latestDataDate ?? '—'}
          sub={state.latestDataDate ? 'last successful screener fetch' : 'no successful screener yet'}
        />
        <StatBlock
          label="Last screener"
          value={
            <span className="flex items-center gap-2">
              <Pill tone={statusTone(state.latestScreener?.status)}>{state.latestScreener?.status ?? 'never'}</Pill>
              <span className="text-xs text-slate-500">{formatRelative(state.latestScreener?.ran_at)}</span>
            </span>
          }
          sub={state.latestScreener ? `run_date=${state.latestScreener.run_date}` : undefined}
        />
        <StatBlock
          label="Last outcome tracker"
          value={
            <span className="flex items-center gap-2">
              <Pill tone={statusTone(state.latestOutcome?.status)}>{state.latestOutcome?.status ?? 'never'}</Pill>
              <span className="text-xs text-slate-500">{formatRelative(state.latestOutcome?.ran_at)}</span>
            </span>
          }
          sub={state.latestOutcome ? `run_date=${state.latestOutcome.run_date}` : undefined}
        />
        <StatBlock
          label="Last summary"
          value={
            <span className="flex items-center gap-2">
              <Pill tone={statusTone(state.latestSummary?.status)}>{state.latestSummary?.status ?? 'never'}</Pill>
              <span className="text-xs text-slate-500">{formatRelative(state.latestSummary?.ran_at)}</span>
            </span>
          }
          sub={state.latestSummary ? `run_date=${state.latestSummary.run_date}` : undefined}
        />
      </div>

      {state.polygonNotAuthorized ? (
        <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
          <strong>Polygon: NOT_AUTHORIZED.</strong> The configured Polygon plan
          refused at least one grouped-bars request ({formatRelative(state.polygonNotAuthorized.ranAt)}).
          The free tier does not include current-day grouped bars; subscribe to
          a plan that does (Stocks Starter or above) and rerun{' '}
          <code>npm run smoke:provider</code>.
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-rose-700">Vendor message</summary>
            <pre className="mt-1 overflow-auto rounded bg-rose-900/10 p-2 text-[11px] text-rose-900">{state.polygonNotAuthorized.sample}</pre>
          </details>
        </div>
      ) : null}

      {state.lastNotSettled ? (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <strong>Stale data refused:</strong> the most recent screener run for{' '}
          <code>{state.lastNotSettled.runDate}</code> saw the provider&apos;s latest bar
          as <code>{state.lastNotSettled.dataDate}</code> and refused to enter trades
          ({formatRelative(state.lastNotSettled.ranAt)}). On the free Polygon tier
          this is expected for current-day requests; upgrade the plan or run after
          settlement.
        </div>
      ) : null}

      {state.marketProvider === 'mock' ? (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <strong>Mock data active.</strong> Candidates and trades shown below are
          synthetic. Set <code>POLYGON_API_KEY</code> and{' '}
          <code>MOCK_MARKET_DATA=false</code> in production env to see real data.
        </div>
      ) : null}

      {state.aiMode === 'mock' && state.marketProvider !== 'mock' ? (
        <div className="mt-4 rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900">
          <strong>Mock AI active.</strong> Tier decisions are deterministic stubs.
          Set <code>ANTHROPIC_API_KEY</code> and <code>USE_MOCK_AI=false</code> for
          real Claude analyses.
        </div>
      ) : null}

      {state.aiBudgetExhaustedToday ? (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <strong>AI daily budget cap hit.</strong> The screener run for{' '}
          <code>{state.aiBudgetExhaustedToday.runDate}</code> spent{' '}
          ${state.aiBudgetExhaustedToday.spent.toFixed(4)} against a cap of $
          {state.aiBudgetExhaustedToday.cap.toFixed(2)} ({formatRelative(state.aiBudgetExhaustedToday.ranAt)}).
          Remaining candidates were routed to the deterministic PASS analyzer
          for the rest of that run. Cap resets at 00:00 UTC.
        </div>
      ) : null}

      {state.cronOpenToPublic ? (
        <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
          <strong>Cron is unauthenticated on this deployment.</strong>{' '}
          <code>CRON_SECRET</code> is unset and{' '}
          <code>ALLOW_UNAUTHENTICATED_CRON=true</code>, which means anyone on the
          internet can hit <code>/api/jobs/*</code> and{' '}
          <code>/api/broker/cancel-all</code>. This is only safe for local dev.
          Rotate a fresh <code>CRON_SECRET</code> in and redeploy before exposing
          this URL.
        </div>
      ) : null}
    </section>
  );
}
