'use client';

import { useEffect } from 'react';

// App-level error boundary. Server components throwing through to here would
// otherwise render Next's default unstyled page. We keep the message minimal
// and never include `error.stack` because Next exposes it client-side and we
// don't want to leak internals on a public deploy.
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Client-side: we cannot import the server-only structured logger here
    // (it's bundled either way, but we keep the shape consistent so a
    // log search across server + client traces still matches).
    console.error(JSON.stringify({
      level: 'error',
      time: new Date().toISOString(),
      event: 'app_error_boundary',
      errorMessage: error.message,
      digest: error.digest ?? null
    }));
  }, [error]);

  return (
    <main className="mx-auto max-w-2xl p-8">
      <div className="rounded-lg border border-rose-200 bg-rose-50 p-6">
        <h1 className="text-lg font-semibold text-rose-900">Something went wrong rendering the dashboard.</h1>
        <p className="mt-2 text-sm text-rose-800">
          The most common cause is a Supabase connectivity blip or schema drift. Check{' '}
          <code>/api/health</code> for diagnostic flags, then reload.
        </p>
        {error.digest ? (
          <p className="mt-2 font-mono text-xs text-rose-700">
            digest: {error.digest}
          </p>
        ) : null}
        <div className="mt-4 flex gap-2">
          <button
            onClick={reset}
            className="rounded bg-rose-700 px-3 py-1 text-sm font-medium text-white hover:bg-rose-800"
          >
            Try again
          </button>
          <a
            href="/api/health"
            className="rounded border border-rose-300 px-3 py-1 text-sm font-medium text-rose-800 hover:bg-rose-100"
          >
            Check /api/health
          </a>
        </div>
      </div>
    </main>
  );
}
