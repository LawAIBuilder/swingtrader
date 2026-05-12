import type { IntradayTradeRow } from '@/lib/dashboard/data';
import { money } from '@/lib/utils/numbers';
import { Pill } from './Pill';
import { StatusBadge } from './StatusBadge';

function bps(value: number | null | undefined): string {
  if (value == null) return '-';
  return `${value} bps`;
}

function fmtTime(iso: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('en-US', { hour12: false });
}

export function IntradayTradesList({ rows }: { rows: IntradayTradeRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Ticker</th>
            <th>Status</th>
            <th>Source</th>
            <th>Entered</th>
            <th>Entry / Stop / Target</th>
            <th>Spread</th>
            <th>Slip RT</th>
            <th>MAE / MFE</th>
            <th>Exit</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="font-semibold">{r.ticker}</td>
              <td><StatusBadge value={r.status} /></td>
              <td className="text-xs uppercase text-slate-500">
                {r.signal_source ?? '-'}
              </td>
              <td className="text-xs text-slate-500">{fmtTime(r.entered_at)}</td>
              <td className="font-mono text-xs">
                {money(r.entry_price)} / {money(r.stop_price)} / {money(r.target_price)}
              </td>
              <td>{bps(r.spread_bps_at_entry)}</td>
              <td>{bps(r.modeled_slippage_bps)}</td>
              <td className="text-xs text-slate-500">
                {bps(r.max_adverse_excursion_bps)} / {bps(r.max_favorable_excursion_bps)}
              </td>
              <td className="text-xs">
                {r.exited_at ? (
                  <div>
                    <div>{money(r.exit_price)}</div>
                    <Pill tone="info">{r.exit_reason ?? r.status}</Pill>
                  </div>
                ) : (
                  <span className="text-slate-400">open</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
