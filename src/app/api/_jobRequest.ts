import { NextResponse, type NextRequest } from 'next/server';
import { errorFields, logError } from '@/lib/log';
import { JobLockedError } from '@/lib/run-log';

export interface JobInvocation {
  runDate?: string;
  force?: boolean;
}

// Vercel Cron sends GET without a body. Manual reruns can POST a JSON payload
// containing { runDate, force } to override. Query string is also accepted so
// `curl https://.../api/jobs/screener?force=1` works without setting headers.
export async function readJobInvocation(req: NextRequest): Promise<JobInvocation> {
  const url = new URL(req.url);
  const queryRunDate = url.searchParams.get('runDate') ?? undefined;
  const queryForce = url.searchParams.get('force');

  let body: { runDate?: unknown; force?: unknown } = {};
  if (req.method === 'POST') {
    body = (await req.json().catch(() => ({}))) as typeof body;
  }

  const runDate = typeof body.runDate === 'string' ? body.runDate : queryRunDate;
  const force = body.force === true || queryForce === '1' || queryForce === 'true';
  return { runDate, force };
}

// Centralized translation for any failure mode the job pipeline can produce.
// JobLockedError -> 409; everything else -> 500 with a structured stderr line
// so a hung-then-failed cron tick is at least visible in Vercel runtime logs.
export function jobErrorResponse(jobName: string, runDate: string | undefined, err: unknown): NextResponse {
  if (err instanceof JobLockedError) {
    return NextResponse.json(
      { skipped: true, reason: err.reason, jobName: err.jobName, runDate: err.runDate },
      { status: 409 }
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  logError('job_route_failure', { job: jobName, runDate: runDate ?? null, ...errorFields(err) });
  return NextResponse.json({ error: message }, { status: 500 });
}
