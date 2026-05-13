import { MarketDataNotSettledError, runScreener } from '@/lib/screener/run';
import { businessDatesBack, todayInNewYork } from '@/lib/utils/dates';

const endDate = process.argv[2] ?? todayInNewYork();
const dates = businessDatesBack(endDate, 30);

interface SmokeRow {
  runDate: string;
  dataDate: string;
  candidates: number | string;
  rough: number | string;
  status: 'ok' | 'stale' | 'skipped' | 'errored';
  note?: string;
}

const rows: SmokeRow[] = [];

for (const date of dates) {
  try {
    // requireSettled=false: in historical smoke mode we tolerate dates that are US
    // market holidays. Those rows will report dataDate as the prior business day so
    // they are visible but obviously skewed.
    const result = await runScreener(date, { requireSettled: false });
    const stale = result.dataDate !== date;
    rows.push({
      runDate: date,
      dataDate: result.dataDate,
      candidates: result.candidates.length,
      rough: result.roughCandidates,
      status: stale ? 'stale' : 'ok',
      note: stale ? 'data_date != run_date (holiday or unsettled)' : undefined
    });
  } catch (err) {
    if (err instanceof MarketDataNotSettledError) {
      rows.push({
        runDate: date,
        dataDate: err.dataDate,
        candidates: 'skipped',
        rough: 'skipped',
        status: 'skipped',
        note: 'MarketDataNotSettled — provider has no bars for this date yet'
      });
      continue;
    }
    // Surface errors as a row instead of bailing the whole sweep. An operator
    // running smoke-historical mostly cares about the shape of the output;
    // one transient day shouldn't kill the rest.
    rows.push({
      runDate: date,
      dataDate: '—',
      candidates: 'error',
      rough: 'error',
      status: 'errored',
      note: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)
    });
  }
}

console.table(rows);

const okCount = rows.filter((r) => r.status === 'ok').length;
const staleCount = rows.filter((r) => r.status === 'stale').length;
const skippedCount = rows.filter((r) => r.status === 'skipped').length;
const erroredCount = rows.filter((r) => r.status === 'errored').length;
const total = rows.reduce((sum, r) => sum + (typeof r.candidates === 'number' ? r.candidates : 0), 0);

console.log('');
console.log(`Days swept: ${rows.length}`);
console.log(`  ok:      ${okCount}  (data_date == run_date)`);
console.log(`  stale:   ${staleCount} (data_date older than run_date)`);
console.log(`  skipped: ${skippedCount} (provider had no bars)`);
console.log(`  errored: ${erroredCount}`);
console.log(`Total candidates across ok+stale days: ${total}`);

if (staleCount > 0 || skippedCount > 0) {
  console.log('');
  console.log('Note: stale/skipped days are EXPECTED on the free Polygon tier');
  console.log('(no current-day grouped bars) and on US market holidays. To eliminate');
  console.log('them, upgrade the Polygon plan and run with MARKET_DATA_FRESHNESS_MODE=same_day_required.');
}
if (erroredCount > 0) process.exitCode = 1;
