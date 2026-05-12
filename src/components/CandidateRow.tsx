import Link from 'next/link';
import type { CandidateView } from '@/lib/dashboard/data';
import { compactNumber, money, pct, pctAlready } from '@/lib/utils/numbers';
import { Pill } from './Pill';
import { StatusBadge } from './StatusBadge';

export function CandidateTable({ rows }: { rows: CandidateView[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Ticker</th>
            <th>Screen</th>
            <th>Tier</th>
            <th>Pre-flag</th>
            <th>Change</th>
            <th>Rel vol</th>
            <th>Price</th>
            <th>Mkt cap</th>
            <th>Sector</th>
            <th>Stop / target</th>
            <th>Thesis</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const tier = r.effective_tier ?? r.ai_tier ?? r.auto_disposition ?? '-';
            const flagsList = Array.isArray(r.risk_flags) ? r.risk_flags : [];
            return (
              <tr key={`${r.id}-${r.screen_source}`}>
                <td className="font-semibold">{r.ticker}</td>
                <td className="text-xs uppercase text-slate-500">{r.screen_source}</td>
                <td><StatusBadge value={tier} /></td>
                <td>
                  {r.auto_disposition && r.auto_disposition !== 'OK_FOR_AI' ? (
                    <StatusBadge value={r.auto_disposition} />
                  ) : (
                    <span className="text-xs text-slate-400">ok</span>
                  )}
                </td>
                <td>{pctAlready(r.pct_change)}</td>
                <td>{Number(r.rel_volume ?? 0).toFixed(2)}x</td>
                <td>{money(r.price)}</td>
                <td>{compactNumber(r.market_cap)}</td>
                <td className="text-xs text-slate-600">{r.sector ?? '-'}</td>
                <td className="text-xs text-slate-600">
                  {r.stop_price != null && r.target_price != null ? (
                    <>
                      <span className="text-rose-700">{money(r.stop_price)}</span>
                      <span className="px-1 text-slate-400">→</span>
                      <span className="text-emerald-700">{money(r.target_price)}</span>
                    </>
                  ) : (
                    <span className="text-slate-400">pending entry</span>
                  )}
                </td>
                <td className="max-w-md">
                  <p className="whitespace-normal text-sm text-slate-700">{r.thesis ?? '—'}</p>
                  {r.selloff_type ? (
                    <p className="mt-1 text-[11px] uppercase tracking-wide text-slate-400">selloff: {r.selloff_type}</p>
                  ) : null}
                  {flagsList.length > 0 ? (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {flagsList.map((flag, i) => (
                        <Pill
                          key={`${r.id}-${flag}-${i}`}
                          tone={flag === 'analysis_failed' || flag === 'mock_ai' ? 'danger' : 'warning'}
                        >
                          {flag}
                        </Pill>
                      ))}
                    </div>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function OpenTradesList({ rows }: { rows: import('@/lib/dashboard/data').OpenTradeView[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Ticker</th>
            <th>Tier</th>
            <th>Entry</th>
            <th>Stop</th>
            <th>Target</th>
            <th>Day</th>
            <th>P/L net</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="font-semibold">{r.ticker}</td>
              <td><StatusBadge value={r.effective_tier} /></td>
              <td>{money(r.entry_price)}</td>
              <td className="text-rose-700">{money(r.stop_price)}</td>
              <td className="text-emerald-700">{money(r.target_price)}</td>
              <td>{r.days_open ?? '—'}</td>
              <td>{pct(r.latest_pnl_net)}</td>
              <td className="text-right">
                <Link className="text-xs text-sky-700 hover:underline" href={`/trades/${r.id}`}>details →</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ClosedTradesList({ rows }: { rows: import('@/lib/dashboard/data').ClosedTradeView[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Ticker</th>
            <th>Tier</th>
            <th>Exit date</th>
            <th>Reason</th>
            <th>Net</th>
            <th>Gross</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="font-semibold">{r.ticker}</td>
              <td><StatusBadge value={r.effective_tier} /></td>
              <td className="text-xs">{r.exit_date ?? '—'}</td>
              <td className="text-xs">{r.exit_reason ?? '—'}{r.had_ambiguous_day ? ' (amb.)' : ''}</td>
              <td className={Number(r.pnl_pct_net ?? 0) >= 0 ? 'text-emerald-700' : 'text-rose-700'}>
                {pct(r.pnl_pct_net)}
              </td>
              <td className="text-xs text-slate-500">{pct(r.pnl_pct_gross)}</td>
              <td className="text-right">
                <Link className="text-xs text-sky-700 hover:underline" href={`/trades/${r.id}`}>details →</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
