import { NextResponse, type NextRequest } from 'next/server';
import { isAuthorizedCron, unauthorizedResponse } from '@/app/api/_auth';
import { jobErrorResponse, readJobInvocation } from '@/app/api/_jobRequest';
import { rateLimitOk } from '@/app/api/_rateLimit';
import { runDailySummaryJob } from '@/jobs/summary';

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
  const invocation = await readJobInvocation(req);
  try {
    const result = await runDailySummaryJob(invocation);
    return NextResponse.json(result);
  } catch (err) {
    return jobErrorResponse('daily_summary', invocation.runDate, err);
  }
}

export const GET = handle;
export const POST = handle;
