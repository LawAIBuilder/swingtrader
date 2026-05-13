import { NextResponse, type NextRequest } from 'next/server';
import { isAuthorizedCron, unauthorizedResponse } from '@/app/api/_auth';
import { jobErrorResponse, readJobInvocation } from '@/app/api/_jobRequest';
import { rateLimitOk } from '@/app/api/_rateLimit';
import { runScreenerJob } from '@/jobs/screener';

// Job runs against Polygon + Anthropic + Supabase. Large universes can exceed
// the Hobby-tier 10s limit; on Pro we cap at 300s. Vercel Cron triggers this
// endpoint once per weekday after market close (see vercel.json).
export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

async function handle(req: NextRequest) {
  if (!rateLimitOk(req)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }
  if (!isAuthorizedCron(req)) {
    return unauthorizedResponse();
  }
  const invocation = await readJobInvocation(req);
  try {
    const result = await runScreenerJob(invocation);
    return NextResponse.json(result);
  } catch (err) {
    return jobErrorResponse('screener', invocation.runDate, err);
  }
}

export const GET = handle;
export const POST = handle;
