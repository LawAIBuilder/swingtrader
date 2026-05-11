import { env } from '@/lib/env';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { todayInNewYork } from '@/lib/utils/dates';

export type RunStatus = 'running' | 'success' | 'partial' | 'failed' | 'skipped';

// Thrown when a job declines to start because another instance for the same
// (run_date, job_name) is already 'running' and the caller did not pass
// force=true. The HTTP layer translates this to a 409. CLIs print and exit 0.
export class JobLockedError extends Error {
  readonly name = 'JobLockedError';
  readonly jobName: string;
  readonly runDate: string;
  readonly reason: string;
  constructor(jobName: string, runDate: string, reason: string) {
    super(`Job ${jobName} declined to start for ${runDate}: ${reason}`);
    this.jobName = jobName;
    this.runDate = runDate;
    this.reason = reason;
  }
}

export interface RunLogOptions {
  runDate?: string;
  // When true, supersede any existing 'running' row for the same
  // (run_date, job_name) instead of refusing to start.
  force?: boolean;
  // Override the stale-lock TTL. Defaults to env.runLockTtlMs.
  staleAfterMs?: number;
}

// Postgres unique-violation; thrown when the partial unique index on
// run_logs(run_date, job_name) WHERE status='running' rejects a second insert.
const PG_UNIQUE_VIOLATION = '23505';

// Best-effort logging of unrecoverable boot failures (e.g. service role key
// missing on Vercel, Supabase unreachable). Prints a single structured line to
// stderr so Vercel runtime logs at least show the cron tick happened.
function logBootFailure(jobName: string, runDate: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(JSON.stringify({
    event: 'run_log_boot_failure',
    job: jobName,
    runDate,
    error: message
  }));
}

// Used by callers (CLI/HTTP) that need a public, non-throwing write path. The
// lifecycle inside withRunLog uses lower-level helpers below.
export async function writeRunLog(args: {
  runDate?: string;
  jobName: string;
  status: 'success' | 'partial' | 'failed';
  details?: Record<string, unknown>;
  durationMs?: number;
}): Promise<void> {
  try {
    const supabase = getSupabaseAdmin();
    const { error } = await supabase.from('run_logs').insert({
      run_date: args.runDate ?? todayInNewYork(),
      job_name: args.jobName,
      status: args.status,
      details: args.details ?? {},
      duration_ms: args.durationMs ?? null,
      finished_at: new Date().toISOString()
    });
    if (error) {
      console.error('Failed to write run log', error);
    }
  } catch (err) {
    logBootFailure(args.jobName, args.runDate ?? todayInNewYork(), err);
  }
}

interface AcquireResult {
  acquired: true;
  rowId: number;
}

interface DeclineResult {
  acquired: false;
  reason: 'concurrent_run_in_progress';
}

async function reapStaleRunningRows(runDate: string, jobName: string, staleMs: number): Promise<void> {
  const supabase = getSupabaseAdmin();
  const cutoff = new Date(Date.now() - staleMs).toISOString();
  const { error } = await supabase
    .from('run_logs')
    .update({
      status: 'failed',
      finished_at: new Date().toISOString(),
      details: { reason: 'stale_lock_reaped', staleAfterMs: staleMs }
    })
    .eq('run_date', runDate)
    .eq('job_name', jobName)
    .eq('status', 'running')
    .lt('ran_at', cutoff);
  if (error) {
    console.error('Failed to reap stale run_logs row', error);
  }
}

async function tryInsertRunningRow(runDate: string, jobName: string, forced: boolean): Promise<{
  ok: true;
  rowId: number;
} | {
  ok: false;
  conflict: boolean;
  error: { code?: string; message: string };
}> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('run_logs')
    .insert({
      run_date: runDate,
      job_name: jobName,
      status: 'running',
      forced,
      details: {}
    })
    .select('id')
    .single();
  if (!error && data) {
    return { ok: true, rowId: (data as unknown as { id: number }).id };
  }
  const conflict = error?.code === PG_UNIQUE_VIOLATION;
  return {
    ok: false,
    conflict,
    error: { code: error?.code, message: error?.message ?? 'unknown insert error' }
  };
}

async function supersedePriorRunningRows(runDate: string, jobName: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from('run_logs')
    .update({
      status: 'failed',
      finished_at: new Date().toISOString(),
      details: { reason: 'superseded_by_force' }
    })
    .eq('run_date', runDate)
    .eq('job_name', jobName)
    .eq('status', 'running');
  if (error) {
    throw new Error(`Failed to supersede prior running run_logs row: ${error.message}`);
  }
}

async function acquireLock(runDate: string, jobName: string, force: boolean, staleMs: number): Promise<AcquireResult | DeclineResult> {
  await reapStaleRunningRows(runDate, jobName, staleMs);

  const first = await tryInsertRunningRow(runDate, jobName, force);
  if (first.ok) return { acquired: true, rowId: first.rowId };

  if (!first.conflict) {
    throw new Error(`run_logs lock insert failed: ${first.error.message}`);
  }

  if (!force) {
    return { acquired: false, reason: 'concurrent_run_in_progress' };
  }

  await supersedePriorRunningRows(runDate, jobName);
  const retry = await tryInsertRunningRow(runDate, jobName, true);
  if (retry.ok) return { acquired: true, rowId: retry.rowId };
  throw new Error(`run_logs lock insert failed after force: ${retry.error.message}`);
}

async function logSkippedRun(runDate: string, jobName: string, reason: string, attemptedForce: boolean): Promise<void> {
  try {
    const supabase = getSupabaseAdmin();
    const { error } = await supabase
      .from('run_logs')
      .insert({
        run_date: runDate,
        job_name: jobName,
        status: 'skipped',
        forced: attemptedForce,
        duration_ms: 0,
        details: { reason },
        finished_at: new Date().toISOString()
      });
    if (error) console.error('Failed to write skipped run_logs row', error);
  } catch (err) {
    logBootFailure(jobName, runDate, err);
  }
}

async function markRowComplete(rowId: number, status: Exclude<RunStatus, 'running'>, durationMs: number, details: Record<string, unknown>): Promise<void> {
  const supabase = getSupabaseAdmin();
  // Only transition from 'running' to a terminal status. If a force=true
  // sibling already marked this row as 'failed' (reason: superseded_by_force),
  // the no-op match here is intentional: we leave the supersede marker in
  // place and let the surviving force-run own the success entry.
  const { error } = await supabase
    .from('run_logs')
    .update({
      status,
      duration_ms: durationMs,
      details,
      finished_at: new Date().toISOString()
    })
    .eq('id', rowId)
    .eq('status', 'running');
  if (error) {
    console.error('Failed to update run_logs lifecycle row', error);
  }
}

function deriveTerminalStatus<T>(result: T): 'success' | 'partial' {
  if (!result || typeof result !== 'object') return 'success';
  const obj = result as Record<string, unknown>;
  // Screener returns notSettled when market data isn't ready. Outcome tracker
  // and summary may grow similar markers. Either condition demotes a
  // technically-completed run to 'partial' so dashboards show the gap.
  if (obj.notSettled != null) return 'partial';
  const errs = obj.errors;
  if (Array.isArray(errs) && errs.length > 0) return 'partial';
  return 'success';
}

export async function withRunLog<T>(
  jobName: string,
  options: RunLogOptions,
  fn: () => Promise<T>
): Promise<T> {
  const runDate = options.runDate ?? todayInNewYork();
  const force = options.force ?? false;
  const staleMs = options.staleAfterMs ?? env.runLockTtlMs;

  let lock: AcquireResult | DeclineResult;
  try {
    lock = await acquireLock(runDate, jobName, force, staleMs);
  } catch (err) {
    // Boot-time failure: most often a missing service role key on Vercel, or
    // Supabase unreachable. We cannot record a run_logs row in this state, so
    // emit a structured stderr line that Vercel will capture, then rethrow.
    logBootFailure(jobName, runDate, err);
    throw err;
  }

  if (!lock.acquired) {
    await logSkippedRun(runDate, jobName, lock.reason, force);
    throw new JobLockedError(jobName, runDate, lock.reason);
  }

  const started = Date.now();
  try {
    const result = await fn();
    const status = deriveTerminalStatus(result);
    await markRowComplete(lock.rowId, status, Date.now() - started, { result });
    return result;
  } catch (err) {
    await markRowComplete(lock.rowId, 'failed', Date.now() - started, {
      error: err instanceof Error ? err.message : String(err)
    });
    throw err;
  }
}
