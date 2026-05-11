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

export async function runDailySummaryJob(runDate = todayInNewYork()): Promise<SummaryJobResult> {
  return withRunLog('daily_summary', runDate, async () => {
    const markdown = await renderDailySummary(runDate);
    const email = await sendEmail({ subject: `Bounce Trader Daily Summary - ${runDate}`, markdown });
    if (email.sent) return { runDate, emailed: true };

    await mkdir('reports', { recursive: true });
    const fallbackPath = join('reports', `daily-summary-${runDate}.md`);
    await writeFile(fallbackPath, markdown, 'utf-8');
    return { runDate, emailed: false, fallbackPath, reason: email.reason };
  });
}
