import type { RunLogRow } from '@/lib/dashboard/data';
import { JsonBlock } from './JsonBlock';
import { StatusBadge } from './StatusBadge';

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function RunLogTable({ rows, expandable = true }: { rows: RunLogRow[]; expandable?: boolean }) {
  if (rows.length === 0) {
    return <p className="text-sm text-slate-500">No job runs recorded yet.</p>;
  }
  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <details key={row.id} open={false} className="rounded-lg border border-slate-200 bg-white">
          <summary className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
            <span className="w-32 shrink-0 text-xs text-slate-500">{formatTime(row.ran_at)}</span>
            <span className="w-32 shrink-0 font-medium text-slate-900">{row.job_name}</span>
            <StatusBadge value={row.status} />
            <span className="text-xs text-slate-500">{row.run_date}</span>
            <span className="ml-auto text-xs text-slate-500">{formatDuration(row.duration_ms)}</span>
          </summary>
          {expandable ? (
            <div className="border-t border-slate-200 p-3">
              <JsonBlock value={row.details ?? {}} maxHeight={300} />
            </div>
          ) : null}
        </details>
      ))}
    </div>
  );
}
