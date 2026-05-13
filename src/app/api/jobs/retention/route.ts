import { NextResponse, type NextRequest } from 'next/server';
import { isAuthorizedCron, unauthorizedResponse } from '@/app/api/_auth';
import { jobErrorResponse, readJobInvocation } from '@/app/api/_jobRequest';
import { rateLimitOk } from '@/app/api/_rateLimit';
import { runRetentionJob } from '@/jobs/retention';

// Cleans up old run_logs and intraday_progression rows. Designed for
// once-a-day or once-a-week external scheduling. Idempotent: re-running it
// the same day is safe.
export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

async function handle(req: NextRequest) {
  if (!rateLimitOk(req)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }
  if (!isAuthorizedCron(req)) {
    return unauthorizedResponse();
  }
  let invocation;
  try {
    invocation = await readJobInvocation(req);
  } catch (err) {
    return jobErrorResponse('retention', undefined, err);
  }
  try {
    const result = await runRetentionJob(invocation);
    return NextResponse.json(result);
  } catch (err) {
    return jobErrorResponse('retention', invocation.runDate, err);
  }
}

export const GET = handle;
export const POST = handle;
