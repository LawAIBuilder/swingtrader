import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card } from '@/components/Card';
import { JsonBlock } from '@/components/JsonBlock';
import { Pill } from '@/components/Pill';
import { StatusBadge } from '@/components/StatusBadge';
import { fetchTradeDetail } from '@/lib/dashboard/data';
import { hasPublicSupabaseConfig } from '@/lib/env';
import { money, pct } from '@/lib/utils/numbers';

export const dynamic = 'force-dynamic';

interface Params {
  params: Promise<{ id: string }>;
}

function field(label: string, value: React.ReactNode) {
  return (
    <div className="rounded-md bg-slate-50 px-3 py-2 ring-1 ring-slate-200">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-0.5 text-sm font-medium text-slate-900">{value ?? '—'}</div>
    </div>
  );
}

function asNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  return String(value);
}

export default async function TradeDetailPage({ params }: Params) {
  const resolved = await params;
  const id = Number(resolved.id);
  if (!Number.isFinite(id)) notFound();

  if (!hasPublicSupabaseConfig()) {
    return (
      <main className="mx-auto max-w-4xl space-y-6 p-6">
        <Card title="Setup needed">
          <p className="text-sm text-slate-700">Configure Supabase env vars before viewing trade details.</p>
        </Card>
      </main>
    );
  }

  const detail = await fetchTradeDetail(id);
  if (!detail || !detail.trade) notFound();

  const trade = detail.trade;
  const candidate = detail.candidate ?? {};
  const preFlags = detail.preFlags ?? {};
  const analysis = detail.analysis ?? {};
  const progression = detail.progression;

  const ticker = asString(trade.ticker) ?? '';
  const status = asString(trade.status);
  const tier = asString(trade.effective_tier);
  const entryPrice = asNumber(trade.entry_price);
  const stopPrice = asNumber(trade.stop_price);
  const targetPrice = asNumber(trade.target_price);
  const exitPrice = asNumber(trade.exit_price);
  const exitReason = asString(trade.exit_reason);
  const pnlNet = asNumber(trade.pnl_pct_net);
  const pnlGross = asNumber(trade.pnl_pct_gross);

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex items-start justify-between">
        <div>
          <Link href="/" className="text-xs text-sky-700 hover:underline">← back to dashboard</Link>
          <h1 className="mt-1 flex items-center gap-3 text-3xl font-semibold tracking-tight">
            {ticker}
            <StatusBadge value={tier ?? '-'} />
            <StatusBadge value={status ?? '-'} />
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            screen_date={asString(candidate.screen_date) ?? '—'} · trade_id={id}
          </p>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-6">
        {field('Entry', entryPrice != null ? money(entryPrice) : 'pending')}
        {field('Stop', stopPrice != null ? <span className="text-rose-700">{money(stopPrice)}</span> : '—')}
        {field('Target', targetPrice != null ? <span className="text-emerald-700">{money(targetPrice)}</span> : '—')}
        {field('Exit', exitPrice != null ? money(exitPrice) : '—')}
        {field('Net P/L', <span className={(pnlNet ?? 0) >= 0 ? 'text-emerald-700' : 'text-rose-700'}>{pct(pnlNet)}</span>)}
        {field('Gross P/L', <span className="text-slate-600">{pct(pnlGross)}</span>)}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Candidate metadata" subtitle="From the original screener row">
          <div className="grid gap-2 sm:grid-cols-2">
            {field('Screen', asString(candidate.screen_source))}
            {field('Pct change', asNumber(candidate.pct_change) != null ? `${asNumber(candidate.pct_change)?.toFixed(2)}%` : '—')}
            {field('Rel volume', asNumber(candidate.rel_volume)?.toFixed(2) ?? '—')}
            {field('Volume', asNumber(candidate.volume)?.toLocaleString() ?? '—')}
            {field('Price (signal close)', money(asNumber(candidate.price)))}
            {field('Prev close', money(asNumber(candidate.prev_close)))}
            {field('Market cap', asNumber(candidate.market_cap)?.toLocaleString() ?? '—')}
            {field('Sector', asString(candidate.sector))}
            {field('Entry mode', asString(trade.entry_mode))}
            {field('Liquidity bucket', asString(trade.liquidity_bucket))}
            {field('Modeled slippage', asNumber(trade.modeled_slippage_bps) != null ? `${asNumber(trade.modeled_slippage_bps)} bps` : '—')}
            {field('ATR14', asNumber(trade.atr14)?.toFixed(4) ?? '—')}
          </div>
        </Card>

        <Card title="Pre-flags" subtitle="Deterministic gate before any AI spend">
          <div className="grid gap-2 sm:grid-cols-2">
            {field('Auto disposition', asString(preFlags.auto_disposition))}
            {field('Earnings source', asString(preFlags.earnings_source))}
            {field('Offering source', asString(preFlags.offering_source))}
            {field('Has recent offering', String(preFlags.has_recent_offering ?? 'unknown'))}
            {field('Earnings within 5d', String(preFlags.earnings_within_5d ?? 'unknown'))}
            {field('Dividend suspended', String(preFlags.dividend_suspended ?? 'unknown'))}
            {field('Liquidity ok', String(preFlags.liquidity_ok ?? 'unknown'))}
            {field('Wash sale lockout', String(preFlags.wash_sale_lockout ?? 'unknown'))}
            {field('Corp action in window', String(preFlags.corp_action_in_window ?? 'unknown'))}
          </div>
          {Array.isArray(preFlags.reasons) && preFlags.reasons.length > 0 ? (
            <div className="mt-3">
              <div className="text-[10px] uppercase tracking-wide text-slate-500">Reasons</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {(preFlags.reasons as unknown[]).map((reason, i) => (
                  <Pill key={`${i}-${String(reason)}`} tone="warning">{String(reason)}</Pill>
                ))}
              </div>
            </div>
          ) : null}
        </Card>
      </div>

      <Card
        title="AI analysis"
        subtitle={`Prompt ${asString(analysis.prompt_version) ?? '?'} · model ${asString(analysis.model_name) ?? '?'} · ${asNumber(analysis.tokens_used) ?? 0} tokens · est. $${(asNumber(analysis.estimated_cost_usd) ?? 0).toFixed(4)}`}
      >
        {detail.analysis ? (
          <div className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-3">
              {field('Tier', asString(analysis.ai_tier))}
              {field('Selloff type', asString(analysis.selloff_type))}
              {field('Day of drop', asNumber(analysis.day_of_drop) ?? '—')}
              {field('Schema valid', String(analysis.schema_valid ?? 'unknown'))}
              {field('Retry count', asNumber(analysis.retry_count) ?? 0)}
              {field('Analyzed at', asString(analysis.analyzed_at))}
              {field('Input tokens', asNumber(analysis.input_tokens) ?? '—')}
              {field('Output tokens', asNumber(analysis.output_tokens) ?? '—')}
              {field('Estimated cost', `$${(asNumber(analysis.estimated_cost_usd) ?? 0).toFixed(6)}`)}
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-slate-500">Thesis</div>
              <p className="mt-1 whitespace-pre-wrap text-sm text-slate-800">{asString(analysis.thesis) ?? '—'}</p>
            </div>
            {Array.isArray(analysis.risk_flags) && analysis.risk_flags.length > 0 ? (
              <div>
                <div className="text-[10px] uppercase tracking-wide text-slate-500">Risk flags</div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {(analysis.risk_flags as unknown[]).map((flag, i) => (
                    <Pill key={`${i}-${String(flag)}`} tone="warning">{String(flag)}</Pill>
                  ))}
                </div>
              </div>
            ) : null}
            {asString(analysis.raw_response) ? (
              <details>
                <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-700">Raw model response</summary>
                <div className="mt-2">
                  <JsonBlock value={asString(analysis.raw_response)} maxHeight={400} />
                </div>
              </details>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-slate-500">No analysis stored for this candidate.</p>
        )}
      </Card>

      <Card title="Daily progression" subtitle="OHLC simulation under conservative stop-first ambiguity rules">
        {progression.length === 0 ? (
          <p className="text-sm text-slate-500">No daily progression rows yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Date</th>
                  <th>O</th>
                  <th>H</th>
                  <th>L</th>
                  <th>C</th>
                  <th>Touched</th>
                  <th>Net</th>
                </tr>
              </thead>
              <tbody>
                {progression.map((p, i) => (
                  <tr key={`${i}-${asString(p.date)}`}>
                    <td>{asNumber(p.day_number)}</td>
                    <td className="text-xs">{asString(p.date)}</td>
                    <td>{money(asNumber(p.open_price))}</td>
                    <td>{money(asNumber(p.high_price))}</td>
                    <td>{money(asNumber(p.low_price))}</td>
                    <td>{money(asNumber(p.close_price))}</td>
                    <td className="text-xs">
                      {p.touched_stop ? <Pill tone="danger">stop</Pill> : null}
                      {p.touched_target ? <Pill tone="success">target</Pill> : null}
                      {p.is_ambiguous ? <Pill tone="warning">ambiguous</Pill> : null}
                    </td>
                    <td className={(asNumber(p.pnl_pct_net) ?? 0) >= 0 ? 'text-emerald-700' : 'text-rose-700'}>
                      {pct(asNumber(p.pnl_pct_net))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {exitReason ? (
          <p className="mt-3 text-sm text-slate-600">
            Exit reason: <strong>{exitReason}</strong>
          </p>
        ) : null}
      </Card>
    </main>
  );
}
