import pLimit from 'p-limit';
import { env } from '@/lib/env';
import type { MarketDataClient } from '@/lib/market/client';
import { getMarketDataClient } from '@/lib/market/provider';
import { businessDatesBack, todayInNewYork } from '@/lib/utils/dates';
import type { DailyBar, ScreenedCandidate, ScreenSource, TickerMetrics } from '@/types/app';
import { passesUniverseFilter } from './filters';
import { computeMetricsForTicker, evaluateScreens } from './screens';

export interface ScreenerResult {
  runDate: string;
  dataDate: string;
  candidates: ScreenedCandidate[];
  roughCandidates: number;
  detailsFetched: number;
  skippedForDetails: number;
}

// Thrown when the latest market bar available is older than runDate.
// The cron path catches this so a holiday or pre-close run is skipped, not silently
// allowed to enter trades using stale data.
export class MarketDataNotSettledError extends Error {
  readonly name = 'MarketDataNotSettledError';
  readonly runDate: string;
  readonly dataDate: string;
  constructor(runDate: string, dataDate: string) {
    super(`Market data not settled for runDate=${runDate}; latest available dataDate=${dataDate}`);
    this.runDate = runDate;
    this.dataDate = dataDate;
  }
}

export interface RunScreenerOptions {
  // When true (default), the screener throws MarketDataNotSettledError if the latest
  // settled bar is not equal to runDate. Cron callers want this. Historical smoke or
  // backfill tooling can opt out and tolerate skewed dates.
  requireSettled?: boolean;
  // Inject an alternate market data client. Production passes nothing and uses the
  // env-configured singleton; tests pass a fake.
  client?: MarketDataClient;
}

function groupByTicker(groupedBarsByDate: DailyBar[][]): Map<string, DailyBar[]> {
  const byTicker = new Map<string, DailyBar[]>();
  for (const dayBars of groupedBarsByDate) {
    for (const bar of dayBars) {
      if (!byTicker.has(bar.ticker)) byTicker.set(bar.ticker, []);
      byTicker.get(bar.ticker)!.push(bar);
    }
  }
  return byTicker;
}

function chooseLatestDataDate(grouped: Array<{ date: string; bars: DailyBar[] }>): string {
  const withBars = grouped.filter((g) => g.bars.length > 0);
  if (withBars.length === 0) throw new Error('No market bars returned for lookback window');
  return withBars[withBars.length - 1].date;
}

export async function runScreener(runDate = todayInNewYork(), options: RunScreenerOptions = {}): Promise<ScreenerResult> {
  const requireSettled = options.requireSettled ?? true;
  const client = options.client ?? getMarketDataClient();
  const dates = businessDatesBack(runDate, 32);

  // Fan out the 32-day lookback across the configured concurrency cap. Order
  // matters downstream (chooseLatestDataDate inspects the trailing element), so
  // results are reassembled in date order regardless of completion order.
  const groupedLimit = pLimit(env.groupedBarsConcurrency);
  const grouped: Array<{ date: string; bars: DailyBar[] }> = await Promise.all(
    dates.map((date) =>
      groupedLimit(async () => {
        try {
          const bars = await client.getGroupedDailyBars(date);
          return { date, bars };
        } catch {
          // Holidays and provider gaps are expected. Keep going.
          return { date, bars: [] };
        }
      })
    )
  );

  const dataDate = chooseLatestDataDate(grouped);
  if (requireSettled && dataDate !== runDate) {
    throw new MarketDataNotSettledError(runDate, dataDate);
  }
  const usableGrouped = grouped.filter((g) => g.date <= dataDate && g.bars.length > 0).map((g) => g.bars);
  const byTicker = groupByTicker(usableGrouped);

  const rough = [] as Array<{ metrics: TickerMetrics; screens: ScreenSource[] }>;
  for (const [ticker, bars] of byTicker.entries()) {
    const metrics = computeMetricsForTicker(ticker, bars);
    if (!metrics || metrics.date !== dataDate) continue;
    if (metrics.latestBar.close < env.minPrice || metrics.latestBar.close > env.maxPrice) continue;
    if (metrics.avgDollarVolume20d < env.minAvgDollarVolume) continue;
    const screens = evaluateScreens(metrics);
    if (screens.length > 0) rough.push({ metrics, screens });
  }

  rough.sort((a, b) => Math.abs(b.metrics.pctChange) * b.metrics.relVolume - Math.abs(a.metrics.pctChange) * a.metrics.relVolume);

  // Fetch details for a bounded rough set. This avoids thousands of reference-data calls.
  const detailLimit = Math.max(env.maxCandidatesPerScreen * 8, 60);
  const limitedRough = rough.slice(0, detailLimit);
  const limit = pLimit(env.detailsConcurrency);
  const detailed = await Promise.all(
    limitedRough.map((r) =>
      limit(async () => {
        const details = await client.getTickerDetails(r.metrics.ticker).catch(() => null);
        return { ...r, details };
      })
    )
  );

  const byScreen = new Map<ScreenSource, ScreenedCandidate[]>();
  byScreen.set('screen_a', []);
  byScreen.set('screen_b', []);

  let skippedForDetails = 0;
  for (const item of detailed) {
    if (!item.details) {
      skippedForDetails += 1;
      continue;
    }
    const filter = passesUniverseFilter(item.metrics, item.details);
    if (!filter.ok) continue;

    for (const screenSource of item.screens) {
      byScreen.get(screenSource)!.push({
        ...item.metrics,
        screenSource,
        details: item.details,
        sector: item.details.sector ?? null,
        marketCap: item.details.marketCap ?? 0,
        price: item.metrics.latestBar.close
      });
    }
  }

  const candidates = Array.from(byScreen.entries()).flatMap(([screenSource, rows]) => {
    return rows
      .sort((a, b) => b.relVolume - a.relVolume)
      .slice(0, env.maxCandidatesPerScreen)
      .map((r) => ({ ...r, screenSource }));
  });

  return {
    runDate,
    dataDate,
    candidates,
    roughCandidates: rough.length,
    detailsFetched: limitedRough.length,
    skippedForDetails
  };
}
