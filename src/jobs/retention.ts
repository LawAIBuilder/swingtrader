import { logError, logInfo } from '@/lib/log';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { addDays, todayInNewYork } from '@/lib/utils/dates';
import { withRunLog } from '@/lib/run-log';

// Retention sweep. Each table that grows monotonically in production gets a
// generous TTL (90 days for run_logs, 60 days for intraday_progression, 30
// days for old skipped/failed run_logs). The thresholds are loose on purpose:
// the goal is "stop the table from growing forever," not "purge anything we
// might still want to look at." Adjust via env vars if you want to retain
// more.
//
// This job is intentionally NOT mounted on a Vercel Cron schedule by
// default. Run it from a CLI cronjob (or wire it into vercel.json once the
// table sizes warrant it). Idempotent: deleting an already-deleted row is
// a no-op.

interface DeleteResult {
  table: string;
  cutoffDate: string;
  // Some Supabase delete responses don't surface a count without an explicit
  // count parameter. We use returning='representation' on a head select first
  // to count, then delete. We accept the small overhead because retention
  // runs once a day at most.
  rowsDeleted: number;
  error: string | null;
}

interface RetentionConfig {
  runLogsKeepDays: number;
  intradayProgressionKeepDays: number;
  skippedRunLogsKeepDays: number;
}

export const DEFAULT_RETENTION: RetentionConfig = {
  runLogsKeepDays: 90,
  intradayProgressionKeepDays: 60,
  skippedRunLogsKeepDays: 30
};

async function deleteRunLogsBefore(cutoff: string): Promise<DeleteResult> {
  const supabase = getSupabaseAdmin();
  const { count: countBefore, error: countErr } = await supabase
    .from('run_logs')
    .select('id', { count: 'exact', head: true })
    .lt('ran_at', cutoff);
  if (countErr) {
    return { table: 'run_logs', cutoffDate: cutoff, rowsDeleted: 0, error: countErr.message };
  }
  const before = countBefore ?? 0;
  if (before === 0) {
    return { table: 'run_logs', cutoffDate: cutoff, rowsDeleted: 0, error: null };
  }
  const { error: deleteErr } = await supabase.from('run_logs').delete().lt('ran_at', cutoff);
  if (deleteErr) {
    return { table: 'run_logs', cutoffDate: cutoff, rowsDeleted: 0, error: deleteErr.message };
  }
  return { table: 'run_logs', cutoffDate: cutoff, rowsDeleted: before, error: null };
}

async function deleteSkippedRunLogsBefore(cutoff: string): Promise<DeleteResult> {
  const supabase = getSupabaseAdmin();
  const { count: countBefore, error: countErr } = await supabase
    .from('run_logs')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'skipped')
    .lt('ran_at', cutoff);
  if (countErr) {
    return { table: 'run_logs(skipped)', cutoffDate: cutoff, rowsDeleted: 0, error: countErr.message };
  }
  const before = countBefore ?? 0;
  if (before === 0) {
    return { table: 'run_logs(skipped)', cutoffDate: cutoff, rowsDeleted: 0, error: null };
  }
  const { error: deleteErr } = await supabase
    .from('run_logs')
    .delete()
    .eq('status', 'skipped')
    .lt('ran_at', cutoff);
  if (deleteErr) {
    return { table: 'run_logs(skipped)', cutoffDate: cutoff, rowsDeleted: 0, error: deleteErr.message };
  }
  return { table: 'run_logs(skipped)', cutoffDate: cutoff, rowsDeleted: before, error: null };
}

async function deleteIntradayProgressionBefore(cutoff: string): Promise<DeleteResult> {
  const supabase = getSupabaseAdmin();
  // intraday_progression's primary key is (intraday_trade_id, observed_at).
  // We use observed_at < cutoff as the prune predicate. If the table doesn't
  // exist on a given deploy (e.g. user hasn't applied the intraday migration
  // yet), return 0 rather than throwing.
  const { count: countBefore, error: countErr } = await supabase
    .from('intraday_progression')
    .select('intraday_trade_id', { count: 'exact', head: true })
    .lt('observed_at', cutoff);
  if (countErr) {
    if (/relation .* does not exist/i.test(countErr.message)) {
      return { table: 'intraday_progression', cutoffDate: cutoff, rowsDeleted: 0, error: null };
    }
    return { table: 'intraday_progression', cutoffDate: cutoff, rowsDeleted: 0, error: countErr.message };
  }
  const before = countBefore ?? 0;
  if (before === 0) {
    return { table: 'intraday_progression', cutoffDate: cutoff, rowsDeleted: 0, error: null };
  }
  const { error: deleteErr } = await supabase.from('intraday_progression').delete().lt('observed_at', cutoff);
  if (deleteErr) {
    return { table: 'intraday_progression', cutoffDate: cutoff, rowsDeleted: 0, error: deleteErr.message };
  }
  return { table: 'intraday_progression', cutoffDate: cutoff, rowsDeleted: before, error: null };
}

export interface RetentionJobResult {
  runDate: string;
  results: DeleteResult[];
  totalDeleted: number;
  errors: string[];
}

export async function runRetentionJob(
  options: { runDate?: string; force?: boolean } = {},
  config: RetentionConfig = DEFAULT_RETENTION
): Promise<RetentionJobResult> {
  return withRunLog('retention', { runDate: options.runDate, force: options.force }, async () => {
    const runDate = options.runDate ?? todayInNewYork();
    const generalCutoff = addDays(runDate, -config.runLogsKeepDays);
    const skippedCutoff = addDays(runDate, -config.skippedRunLogsKeepDays);
    const intradayCutoff = `${addDays(runDate, -config.intradayProgressionKeepDays)}T00:00:00Z`;

    const results = await Promise.all([
      deleteSkippedRunLogsBefore(skippedCutoff),
      deleteRunLogsBefore(generalCutoff),
      deleteIntradayProgressionBefore(intradayCutoff)
    ]);

    const errors = results.filter((r) => r.error).map((r) => `${r.table}: ${r.error}`);
    const totalDeleted = results.reduce((acc, r) => acc + r.rowsDeleted, 0);

    if (errors.length > 0) {
      logError('retention_partial', { runDate, errors, totalDeleted });
    } else {
      logInfo('retention_done', { runDate, totalDeleted, results });
    }

    return { runDate, results, totalDeleted, errors };
  });
}
