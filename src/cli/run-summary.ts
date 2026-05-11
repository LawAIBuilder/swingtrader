import { runDailySummaryJob } from '@/jobs/summary';

const runDate = process.argv[2];
const result = await runDailySummaryJob(runDate);
console.log(JSON.stringify(result, null, 2));
