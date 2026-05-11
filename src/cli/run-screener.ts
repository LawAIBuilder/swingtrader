import { runScreenerJob } from '@/jobs/screener';
import { JobLockedError } from '@/lib/run-log';

const args = process.argv.slice(2);
const force = args.includes('--force');
const runDate = args.find((a) => !a.startsWith('--'));

try {
  const result = await runScreenerJob({ runDate, force });
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  if (err instanceof JobLockedError) {
    console.log(JSON.stringify({ skipped: true, reason: err.reason, jobName: err.jobName, runDate: err.runDate }, null, 2));
    process.exit(0);
  }
  throw err;
}
