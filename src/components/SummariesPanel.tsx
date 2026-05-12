import type { DailySummaryRow } from '@/lib/dashboard/data';
import { Pill } from './Pill';

export function SummariesPanel({ rows }: { rows: DailySummaryRow[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-slate-500">No daily summaries persisted yet.</p>;
  }
  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <details key={row.id} className="rounded-lg border border-slate-200 bg-white">
          <summary className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
            <span className="w-28 shrink-0 font-mono text-xs text-slate-500">{row.run_date}</span>
            <Pill tone={row.emailed ? 'success' : 'warning'}>{row.emailed ? 'emailed' : 'no email'}</Pill>
            <span className="text-xs text-slate-500">{new Date(row.generated_at).toLocaleString()}</span>
            {row.email_reason ? (
              <span className="ml-auto text-xs text-slate-400">{row.email_reason}</span>
            ) : null}
          </summary>
          <pre className="m-3 max-h-96 overflow-auto rounded-md bg-slate-50 p-3 text-[11px] leading-tight text-slate-800">
            {row.markdown}
          </pre>
        </details>
      ))}
    </div>
  );
}
