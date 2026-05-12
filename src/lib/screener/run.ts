import pLimit from 'p-limit';
import { env } from '@/lib/env';
import type { MarketDataClient } from '@/lib/market/client';
import { getMarketDataClient, getMarketDataProviderInfo, type MarketProviderInfo } from '@/lib/market/provider';
import { businessDatesBack, todayInNewYork } from '@/lib/utils/dates';
import type { DailyBar, ScreenedCandidate, ScreenSource, TickerMetrics } from '@/types/app';
import { passesUniverseFilter } from './filters';
import { computeMetricsForTicker, evaluateScreens } from './screens';

// Per-day fetch outcome for the lookback window. The screener summarizes these
// so dashboards and run logs can show "we asked for 32 days, got 22, latest is
// 2026-05-09, refused current-day with NOT_AUTHORIZED" without rerunning.
export type ScreenerFetchOutcome = 'ok' | 'empty' | 'error';

export interface ScreenerFetchAttempt {
  date: string;
  outcome: ScreenerFetchOutcome;
  bars: number;
  errorMessage?: string;
}

export interface ScreenerDataDiagnostics {
  provider: MarketProviderInfo;
  freshnessMode: 'same_day_required' | 'latest_available';
  requestedRunDate: string;
  // Latest date the provider returned bars for in this fetch window.
  latestAvailableDate: string | null;
  windowSize: number;
  windowOk: number;
  windowEmpty: number;
  windowError: number;
  // First five error messages, deduplicated. Useful to surface auth / quota
  // problems on the dashboard without dumping the whole log.
  errorSamples: string[];
  attempts: ScreenerFetchAttempt[];
}

export interface ScreenerResult {
  runDate: string;
  dataDate: string;
  candidates: ScreenedCandidate[];
  roughCandidates: number;
  detailsFetched: number;
  skippedForDetails: number;
  diagnostics: ScreenerDataDiagnostics;
}

// Thrown when the latest market bar available is older than runDate.
// The cron path catches this so a holiday or pre-close run is skipped, not silently
// allowed to enter trades using stale data.
export class MarketDataNotSettledError extends Error {
  readonly name = 'MarketDataNotSettledError';
  readonly runDate: string;
  readonly dataDate: string;
  readonly diagnostics: ScreenerDataDiagnostics;
  constructor(runDate: string, dataDate: string, diagnostics: ScreenerDataDiagnostics) {
    super(`Market data not settled for runDate=${runDate}; latest available dataDate=${dataDate}`);
    this.runDate = runDate;
    this.dataDate = dataDate;
    this.diagnostics = diagnostics;
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

function buildDiagnostics(args: {
  runDate: string;
  attempts: ScreenerFetchAttempt[];
  latestDate: string | null;
}): ScreenerDataDiagnostics {
  const errorMessages: string[] = [];
  for (const attempt of args.attempts) {
    if (attempt.outcome !== 'error' || !attempt.errorMessage) continue;
    if (errorMessages.includes(attempt.errorMessage)) continue;
    errorMessages.push(attempt.errorMessage);
    if (errorMessages.length >= 5) break;
  }
  return {
    provider: getMarketDataProviderInfo(),
    freshnessMode: env.marketDataFreshnessMode,
    requestedRunDate: args.runDate,
    latestAvailableDate: args.latestDate,
    windowSize: args.attempts.length,
    windowOk: args.attempts.filter((a) => a.outcome === 'ok').length,
    windowEmpty: args.attempts.filter((a) => a.outcome === 'empty').length,
    windowError: args.attempts.filter((a) => a.outcome === 'error').length,
    errorSamples: errorMessages,
    attempts: args.attempts
  };
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

function chooseLatestDataDate(grouped: Array<{ date: string; bars: DailyBar[] }>): string | null {
  const withBars = grouped.filter((g) => g.bars.length > 0);
  if (withBars.length === 0) return null;
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
  const grouped: Array<{ date: string; bars: DailyBar[]; outcome: ScreenerFetchOutcome; errorMessage?: string }> = await Promise.all(
    dates.map((date) =>
      groupedLimit(async () => {
        try {
          const bars = await client.getGroupedDailyBars(date);
          return {
            date,
            bars,
            outcome: (bars.length > 0 ? 'ok' : 'empty') as ScreenerFetchOutcome
          };
        } catch (err) {
          // Holidays and provider gaps look the same to us; we tag them as 'error'
          // so diagnostics can show the actual vendor message (e.g.
          // "NOT_AUTHORIZED" on Polygon's free tier for current-day data).
          return {
            date,
            bars: [] as DailyBar[],
            outcome: 'error' as ScreenerFetchOutcome,
            errorMessage: err instanceof Error ? err.message : String(err)
          };
        }
      })
    )
  );

  const attempts: ScreenerFetchAttempt[] = grouped.map((g) => ({
    date: g.date,
    outcome: g.outcome,
    bars: g.bars.length,
    errorMessage: g.errorMessage
  }));
  const latestDate = chooseLatestDataDate(grouped);
  const diagnostics = buildDiagnostics({ runDate, attempts, latestDate });

  if (latestDate == null) {
    throw new MarketDataNotSettledError(runDate, '', diagnostics);
  }

  if (requireSettled && latestDate !== runDate) {
    throw new MarketDataNotSettledError(runDate, latestDate, diagnostics);
  }
  const dataDate = latestDate;
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
    skippedForDetails,
    diagnostics
  };
}
