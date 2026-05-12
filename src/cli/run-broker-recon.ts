import { runBrokerReconJob } from '@/jobs/broker-recon';
import { JobLockedError } from '@/lib/run-log';

try {
  const result = await runBrokerReconJob();
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  if (err instanceof JobLockedError) {
    console.log(JSON.stringify({ skipped: true, reason: err.reason }, null, 2));
    process.exit(0);
  }
  throw err;
}
