import { NextResponse, type NextRequest } from 'next/server';
import { isAuthorizedCron, unauthorizedResponse } from '@/app/api/_auth';
import { jobErrorResponse } from '@/app/api/_jobRequest';
import { rateLimitOk } from '@/app/api/_rateLimit';
import { runIntradayTickJob } from '@/jobs/intraday';

// Intraday tick. Designed to be called frequently (e.g. once per minute) by
// an external scheduler. Runs no-op when TRADING_MODE does not include
// 'intraday_paper'. Uses the same CRON_SECRET as the EOD jobs.
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
  try {
    const result = await runIntradayTickJob();
    return NextResponse.json(result);
  } catch (err) {
    return jobErrorResponse('intraday_tick', undefined, err);
  }
}

export const GET = handle;
export const POST = handle;
