import { NextResponse, type NextRequest } from 'next/server';
import { errorFields, logError } from '@/lib/log';
import { JobLockedError } from '@/lib/run-log';

export interface JobInvocation {
  runDate?: string;
  force?: boolean;
}

export class InvalidJobInvocationError extends Error {
  readonly name = 'InvalidJobInvocationError';
  readonly code: 'invalid_run_date';
  constructor(code: 'invalid_run_date', message: string) {
    super(message);
    this.code = code;
  }
}

// Strict YYYY-MM-DD with a real calendar check. Rejects 2026-13-01, leap-year
// drift, and any form like "today" or "2026/05/11" so the screener can never
// receive a run_date that won't compare correctly against bar dates.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isValidRunDate(input: string): boolean {
  if (!DATE_RE.test(input)) return false;
  const ts = Date.parse(`${input}T00:00:00Z`);
  if (!Number.isFinite(ts)) return false;
  // Round-trip check: reject 2026-02-30 etc., where Date.parse silently
  // moves the day forward.
  return new Date(ts).toISOString().slice(0, 10) === input;
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
  if (runDate != null && !isValidRunDate(runDate)) {
    throw new InvalidJobInvocationError(
      'invalid_run_date',
      `runDate must be YYYY-MM-DD, got '${runDate}'`
    );
  }
  const force = body.force === true || queryForce === '1' || queryForce === 'true';
  return { runDate, force };
}

// Centralized translation for any failure mode the job pipeline can produce.
// JobLockedError -> 409; InvalidJobInvocationError -> 400; everything else
// -> 500 with a structured stderr line so a hung-then-failed cron tick is at
// least visible in Vercel runtime logs.
export function jobErrorResponse(jobName: string, runDate: string | undefined, err: unknown): NextResponse {
  if (err instanceof JobLockedError) {
    return NextResponse.json(
      { skipped: true, reason: err.reason, jobName: err.jobName, runDate: err.runDate },
      { status: 409 }
    );
  }
  if (err instanceof InvalidJobInvocationError) {
    return NextResponse.json({ error: err.code, detail: err.message }, { status: 400 });
  }
  const message = err instanceof Error ? err.message : String(err);
  logError('job_route_failure', { job: jobName, runDate: runDate ?? null, ...errorFields(err) });
  return NextResponse.json({ error: message }, { status: 500 });
}
