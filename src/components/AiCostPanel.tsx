import type { AiCostDailyRow } from '@/lib/dashboard/data';
import { EmptyState } from './EmptyState';

function fmtUsd(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `$${value.toFixed(4)}`;
}

export function AiCostPanel({ rows }: { rows: AiCostDailyRow[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No real AI calls recorded yet."
        description="Mock AI runs are excluded from cost accounting. Set USE_MOCK_AI=false and rerun the screener."
      />
    );
  }
  const total = rows.reduce((sum, r) => sum + Number(r.cost_usd ?? 0), 0);
  const totalCalls = rows.reduce((sum, r) => sum + Number(r.calls ?? 0), 0);
  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-3">
        <span className="text-2xl font-semibold">{fmtUsd(total)}</span>
        <span className="text-xs text-slate-500">across {totalCalls} call(s) in the recent window</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Day</th>
              <th>Model</th>
              <th>Prompt</th>
              <th>Calls</th>
              <th>Input tok</th>
              <th>Output tok</th>
              <th>Cost</th>
              <th>Valid</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.day}-${r.model_name}-${r.prompt_version}`}>
                <td className="font-mono text-xs">{r.day}</td>
                <td className="text-xs">{r.model_name}</td>
                <td className="text-xs">{r.prompt_version}</td>
                <td>{r.calls}</td>
                <td>{r.input_tokens.toLocaleString()}</td>
                <td>{r.output_tokens.toLocaleString()}</td>
                <td>{fmtUsd(Number(r.cost_usd ?? 0))}</td>
                <td>{r.schema_valid_rate != null ? `${(r.schema_valid_rate * 100).toFixed(0)}%` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
