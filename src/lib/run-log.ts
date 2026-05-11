import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { todayInNewYork } from '@/lib/utils/dates';

export async function writeRunLog(args: {
  runDate?: string;
  jobName: string;
  status: 'success' | 'partial' | 'failed';
  details?: Record<string, unknown>;
  durationMs?: number;
}): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from('run_logs').insert({
    run_date: args.runDate ?? todayInNewYork(),
    job_name: args.jobName,
    status: args.status,
    details: args.details ?? {},
    duration_ms: args.durationMs ?? null
  });
  if (error) {
    console.error('Failed to write run log', error);
  }
}

export async function withRunLog<T>(jobName: string, runDate: string | undefined, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    const obj = (result && typeof result === 'object') ? (result as Record<string, unknown>) : undefined;
    const maybeErrors = (obj?.errors && Array.isArray(obj.errors)) ? (obj.errors as unknown[]) : undefined;
    // A run that returned a notSettled marker is not a success: the cron fired but
    // the underlying market data was not yet available and no work was done. Record
    // it as 'partial' until PR 2 introduces a proper skipped/forced/failed status.
    const notSettled = obj?.notSettled != null;
    const status: 'success' | 'partial' | 'failed' = notSettled || (maybeErrors && maybeErrors.length > 0)
      ? 'partial'
      : 'success';
    await writeRunLog({
      runDate,
      jobName,
      status,
      durationMs: Date.now() - started,
      details: { result }
    });
    return result;
  } catch (err) {
    await writeRunLog({
      runDate,
      jobName,
      status: 'failed',
      durationMs: Date.now() - started,
      details: { error: err instanceof Error ? err.message : String(err) }
    });
    throw err;
  }
}
