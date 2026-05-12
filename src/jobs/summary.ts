import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sendEmail } from '@/lib/email/send';
import { renderDailySummary } from '@/lib/email/summary';
import { withRunLog } from '@/lib/run-log';
import { todayInNewYork } from '@/lib/utils/dates';

export interface SummaryJobResult {
  runDate: string;
  emailed: boolean;
  fallbackPath?: string;
  reason?: string;
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

export async function runDailySummaryJob(options: RunDailySummaryJobOptions = {}): Promise<SummaryJobResult> {
  const runDate = options.runDate ?? todayInNewYork();
  const force = options.force ?? false;
  return withRunLog('daily_summary', { runDate, force }, async () => {
    const markdown = await renderDailySummary(runDate);
    const email = await sendEmail({ subject: `Bounce Trader Daily Summary - ${runDate}`, markdown });
    if (email.sent) return { runDate, emailed: true };

    const fallbackPath = await writeFallback(runDate, markdown);
    if (fallbackPath) {
      return { runDate, emailed: false, fallbackPath, reason: email.reason };
    }
    return { runDate, emailed: false, reason: email.reason ?? 'fallback_disk_unavailable' };
  });
}
