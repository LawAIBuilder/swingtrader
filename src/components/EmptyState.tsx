import type { ReactNode } from 'react';

interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  hint?: ReactNode;
}

export function EmptyState({ title, description, hint }: EmptyStateProps) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center">
      <p className="text-sm font-semibold text-slate-700">{title}</p>
      {description ? <p className="mt-2 text-sm text-slate-500">{description}</p> : null}
      {hint ? <div className="mt-3 text-xs text-slate-500">{hint}</div> : null}
    </div>
  );
}
