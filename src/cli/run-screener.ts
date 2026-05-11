import { runScreenerJob } from '@/jobs/screener';

const runDate = process.argv[2];
const result = await runScreenerJob(runDate);
console.log(JSON.stringify(result, null, 2));
