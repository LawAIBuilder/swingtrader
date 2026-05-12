import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sendEmail } from '@/lib/email/send';
import { renderDailySummary } from '@/lib/email/summary';
import { withRunLog } from '@/lib/run-log';
import { hasSupabaseConfig } from '@/lib/env';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { todayInNewYork } from '@/lib/utils/dates';

export interface SummaryJobResult {
  runDate: string;
  emailed: boolean;
  fallbackPath?: string;
  persisted?: boolean;
  reason?: string;
  // Expose top-level errors so run-log's deriveTerminalStatus can demote to
  // 'partial' when the summary was generated but neither emailed nor
  // persisted — that's a real operator-visible failure even though the job
  // technically completed.
  errors: Array<{ stage: string; message: string }>;
}

export interface RunDailySummaryJobOptions {
  runDate?: string;
  force?: boolean;
}

// On Vercel/AWS Lambda the function filesystem is read-only except for /tmp.
// We still try the local 'reports' dir first so dev/CI runs keep their human-
// readable artifact, but we fall through to /tmp on the read-only deploy
// surface, and finally degrade to no fallback at all rather than 500'ing.
async function writeFallback(runDate: string, markdown: string): Promise<string | null> {
  const filename = `daily-summary-${runDate}.md`;
  const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  const candidates = isServerless ? ['/tmp/reports'] : ['reports', '/tmp/reports'];
  for (const dir of candidates) {
    try {
      await mkdir(dir, { recursive: true });
      const path = join(dir, filename);
      await writeFile(path, markdown, 'utf-8');
      return path;
    } catch {
      // try next candidate
    }
  }
  return null;
}

// Idempotent persistence to Supabase. Same (run_date) overwrites the body so
// reruns don't accumulate dead rows. This is the source of truth for the
// dashboard's recent-summaries panel; the file fallback is only for local dev.
async function persistToSupabase(runDate: string, markdown: string, emailed: boolean, emailReason: string | undefined): Promise<boolean> {
  if (!hasSupabaseConfig()) return false;
  try {
    const supabase = getSupabaseAdmin();
    const { error } = await supabase.from('daily_summaries').upsert(
      {
        run_date: runDate,
        markdown,
        emailed,
        email_reason: emailReason ?? null,
        generated_at: new Date().toISOString()
      },
      { onConflict: 'run_date' }
    );
    if (error) {
      console.error('Failed to persist daily_summary', error);
      return false;
    }
    return true;
  } catch (err) {
    console.error('daily_summary persistence threw', err);
    return false;
  }
}

export async function runDailySummaryJob(options: RunDailySummaryJobOptions = {}): Promise<SummaryJobResult> {
  const runDate = options.runDate ?? todayInNewYork();
  const force = options.force ?? false;
  return withRunLog('daily_summary', { runDate, force }, async () => {
    const errors: SummaryJobResult['errors'] = [];
    const markdown = await renderDailySummary(runDate);
    const email = await sendEmail({ subject: `Bounce Trader Daily Summary - ${runDate}`, markdown });
    const persisted = await persistToSupabase(runDate, markdown, email.sent, email.reason);

    if (!email.sent && email.reason && email.reason !== 'email_disabled' && email.reason !== 'no_recipient') {
      errors.push({ stage: 'email', message: email.reason });
    }
    if (!persisted && hasSupabaseConfig()) {
      errors.push({ stage: 'persist', message: 'daily_summary upsert failed' });
    }

    if (email.sent) {
      return { runDate, emailed: true, persisted, errors };
    }

    const fallbackPath = await writeFallback(runDate, markdown);
    if (fallbackPath) {
      return { runDate, emailed: false, fallbackPath, persisted, reason: email.reason, errors };
    }
    if (!persisted) {
      errors.push({ stage: 'durability', message: 'neither emailed nor persisted nor written to disk' });
    }
    return {
      runDate,
      emailed: false,
      persisted,
      reason: email.reason ?? (persisted ? 'persisted_only' : 'fallback_disk_unavailable'),
      errors
    };
  });
}
