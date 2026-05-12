import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <div className="rounded-lg border border-slate-200 bg-white p-6">
        <h1 className="text-lg font-semibold text-slate-900">Page not found</h1>
        <p className="mt-2 text-sm text-slate-600">
          The dashboard is paper-only. Trade detail URLs require a numeric{' '}
          <code>id</code> matching a row in <code>paper_trades</code>.
        </p>
        <p className="mt-4">
          <Link className="text-sky-700 hover:underline" href="/">Back to dashboard</Link>
        </p>
      </div>
    </main>
  );
}
