import { NextResponse } from 'next/server';

// Plain-text liveness ping for uptime monitors. Cheaper than /api/health
// (no DB probe, no env introspection) so an external poller can hit it
// every 30s without budget concerns. If you need the deeper status, hit
// /api/health.
export const runtime = 'edge';

export function GET() {
  return new NextResponse('ok', {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}
