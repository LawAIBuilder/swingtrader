import { isValidRunDate } from '@/app/api/_jobRequest';
import { runDailySummaryJob } from '@/jobs/summary';
import { JobLockedError } from '@/lib/run-log';

const args = process.argv.slice(2);
const force = args.includes('--force');
const dryRun = args.includes('--dry-run');
const runDate = args.find((a) => !a.startsWith('--'));

if (runDate != null && !isValidRunDate(runDate)) {
  console.error(`Invalid runDate: '${runDate}'. Must be YYYY-MM-DD.`);
  process.exit(2);
}

try {
  const result = await runDailySummaryJob({ runDate, force, dryRun });
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  if (err instanceof JobLockedError) {
    console.log(JSON.stringify({ skipped: true, reason: err.reason, jobName: err.jobName, runDate: err.runDate }, null, 2));
    process.exit(0);
  }
  throw err;
}
