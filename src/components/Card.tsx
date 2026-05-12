import type { ReactNode } from 'react';

interface CardProps {
  title?: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  density?: 'comfortable' | 'compact';
}

export function Card({ title, subtitle, action, children, density = 'comfortable' }: CardProps) {
  const padding = density === 'compact' ? 'p-4' : 'p-5';
  return (
    <section className={`rounded-xl border border-slate-200 bg-white ${padding} shadow-sm`}>
      {(title || action) ? (
        <header className="mb-4 flex items-start justify-between gap-3">
          <div>
            {title ? <h2 className="text-lg font-semibold text-slate-900">{title}</h2> : null}
            {subtitle ? <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p> : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}
