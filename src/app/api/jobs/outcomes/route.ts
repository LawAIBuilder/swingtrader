import { NextResponse, type NextRequest } from 'next/server';
import { isAuthorizedCron } from '@/app/api/_auth';
import { jobErrorResponse, readJobInvocation } from '@/app/api/_jobRequest';
import { rateLimitOk } from '@/app/api/_rateLimit';
import { runOutcomeTrackerJob } from '@/jobs/outcomes';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

async function handle(req: NextRequest) {
  if (!rateLimitOk(req)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const invocation = await readJobInvocation(req);
  try {
    const result = await runOutcomeTrackerJob(invocation);
    return NextResponse.json(result);
  } catch (err) {
    return jobErrorResponse('outcome_tracker', invocation.runDate, err);
  }
}

export const GET = handle;
export const POST = handle;
