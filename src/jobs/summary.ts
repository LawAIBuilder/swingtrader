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

export async function runDailySummaryJob(options: RunDailySummaryJobOptions = {}): Promise<SummaryJobResult> {
  const runDate = options.runDate ?? todayInNewYork();
  const force = options.force ?? false;
  return withRunLog('daily_summary', { runDate, force }, async () => {
    const markdown = await renderDailySummary(runDate);
    const email = await sendEmail({ subject: `Bounce Trader Daily Summary - ${runDate}`, markdown });
    if (email.sent) return { runDate, emailed: true };

    await mkdir('reports', { recursive: true });
    const fallbackPath = join('reports', `daily-summary-${runDate}.md`);
    await writeFile(fallbackPath, markdown, 'utf-8');
    return { runDate, emailed: false, fallbackPath, reason: email.reason };
  });
}
