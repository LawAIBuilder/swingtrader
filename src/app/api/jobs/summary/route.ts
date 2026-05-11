import { NextResponse, type NextRequest } from 'next/server';
import { isAuthorizedCron } from '@/app/api/_auth';
import { jobErrorResponse, readJobInvocation } from '@/app/api/_jobRequest';
import { runDailySummaryJob } from '@/jobs/summary';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

async function handle(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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
