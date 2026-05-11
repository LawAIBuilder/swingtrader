const classByValue: Record<string, string> = {
  BUY: 'bg-emerald-100 text-emerald-800',
  PASS: 'bg-slate-100 text-slate-800',
  AVOID: 'bg-rose-100 text-rose-800',
  BLACKOUT: 'bg-amber-100 text-amber-800',
  OK_FOR_AI: 'bg-sky-100 text-sky-800',
  open: 'bg-blue-100 text-blue-800',
  stopped: 'bg-rose-100 text-rose-800',
  target_hit: 'bg-emerald-100 text-emerald-800',
  time_closed: 'bg-slate-100 text-slate-800'
};

export function StatusBadge({ value }: { value: string | null | undefined }) {
  const v = value ?? '-';
  return <span className={`rounded-full px-2 py-1 text-xs font-semibold ${classByValue[v] ?? 'bg-slate-100 text-slate-800'}`}>{v}</span>;
}
