import { runOutcomeTrackerJob } from '@/jobs/outcomes';

const runDate = process.argv[2];
const result = await runOutcomeTrackerJob(runDate);
console.log(JSON.stringify(result, null, 2));
