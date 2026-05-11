import { MarketDataNotSettledError, runScreener } from '@/lib/screener/run';
import { businessDatesBack, todayInNewYork } from '@/lib/utils/dates';

const endDate = process.argv[2] ?? todayInNewYork();
const dates = businessDatesBack(endDate, 30);
const rows = [] as Array<{ runDate: string; dataDate: string; candidates: number | string; rough: number | string }>;

for (const date of dates) {
  try {
    // requireSettled=false: in historical smoke mode we tolerate dates that are US
    // market holidays. Those rows will report dataDate as the prior business day so
    // they are visible but obviously skewed.
    const result = await runScreener(date, { requireSettled: false });
    rows.push({ runDate: date, dataDate: result.dataDate, candidates: result.candidates.length, rough: result.roughCandidates });
  } catch (err) {
    if (err instanceof MarketDataNotSettledError) {
      rows.push({ runDate: date, dataDate: err.dataDate, candidates: 'skipped', rough: 'skipped' });
      continue;
    }
    throw err;
  }
}

console.table(rows);
const total = rows.reduce((sum, r) => sum + (typeof r.candidates === 'number' ? r.candidates : 0), 0);
console.log(`Total candidates across ${rows.length} smoke-test days: ${total}`);
