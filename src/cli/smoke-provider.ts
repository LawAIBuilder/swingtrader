import { env } from '@/lib/env';
import { getMarketDataClient, getMarketDataProviderInfo } from '@/lib/market/provider';
import { businessDatesBack, todayInNewYork } from '@/lib/utils/dates';

// Manual probe of the configured market-data provider. Used to confirm a
// paid Polygon/Massive plan returns same-day grouped bars after market close
// before flipping production to real data, and to surface the precise
// vendor failure mode (e.g. NOT_AUTHORIZED on the free tier) without staring
// at production logs.
//
// Usage:
//   npm run smoke:provider              # probe today (NY) and recent days
//   npm run smoke:provider -- 2026-05-08

const requested = process.argv[2] ?? todayInNewYork();
const lookback = businessDatesBack(requested, 5);

interface ProbeRow {
  date: string;
  outcome: 'ok' | 'empty' | 'error';
  bars: number;
  ms: number;
  message?: string;
}

async function probe(date: string): Promise<ProbeRow> {
  const client = getMarketDataClient();
  const t0 = Date.now();
  try {
    const bars = await client.getGroupedDailyBars(date);
    return {
      date,
      outcome: bars.length > 0 ? 'ok' : 'empty',
      bars: bars.length,
      ms: Date.now() - t0
    };
  } catch (err) {
    return {
      date,
      outcome: 'error',
      bars: 0,
      ms: Date.now() - t0,
      message: err instanceof Error ? err.message : String(err)
    };
  }
}

const info = getMarketDataProviderInfo();
console.log(JSON.stringify({ event: 'provider_info', ...info }, null, 2));
console.log(JSON.stringify({ event: 'freshness_mode', mode: env.marketDataFreshnessMode }));

const rows: ProbeRow[] = [];
for (const date of lookback) {
  rows.push(await probe(date));
}

console.table(rows.map((r) => ({
  date: r.date,
  outcome: r.outcome,
  bars: r.bars,
  ms: r.ms,
  message: r.message?.slice(0, 80) ?? ''
})));

const ok = rows.filter((r) => r.outcome === 'ok').map((r) => r.date);
const errors = rows.filter((r) => r.outcome === 'error');

if (ok.length === 0) {
  console.error('NO BARS RETURNED on any probed date.');
  if (errors.length > 0) {
    console.error('First error:', errors[0].message);
  }
  process.exit(2);
}

const latest = ok[ok.length - 1];
console.log(`Latest available bar: ${latest}`);
console.log(`Requested run date:   ${requested}`);

if (latest === requested) {
  console.log('OK: provider returned same-day bars for the requested date.');
} else if (latest < requested) {
  console.warn(
    `WARN: provider latest=${latest} is older than requested=${requested}.\n` +
    `If the requested date is a closed session (weekend/holiday), this is fine.\n` +
    `If the requested date is a regular trading day after close (>= 16:15 ET),\n` +
    `the configured plan likely does not include same-day grouped bars. Check\n` +
    `your Polygon/Massive plan or set MARKET_DATA_FRESHNESS_MODE=latest_available\n` +
    `to opt out (smoke/backfill only - not safe for production cron).`
  );
}

if (errors.length > 0) {
  console.warn(`Errors observed on ${errors.length} of ${rows.length} dates. Sample:`);
  for (const e of errors.slice(0, 3)) {
    console.warn(`  ${e.date}: ${e.message}`);
  }
}
