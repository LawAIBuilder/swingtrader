import { NextResponse, type NextRequest } from 'next/server';
import { isAuthorizedCron } from '@/app/api/_auth';
import { runScreenerJob } from '@/jobs/screener';

// Job runs against Polygon + Anthropic + Supabase. Large universes can exceed
// the Hobby-tier 10s limit; on Pro we cap at 300s. Vercel Cron triggers this
// endpoint once per weekday after market close (see vercel.json).
export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

async function handle(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const result = await runScreenerJob(body?.runDate);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export const GET = handle;
export const POST = handle;
