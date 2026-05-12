import { describe, expect, it } from 'vitest';
import type { MarketDataClient } from '@/lib/market/client';
import type { CorporateActionResult, DailyBar, NewsItem, TickerDetails } from '@/types/app';
import { businessDatesBack } from '@/lib/utils/dates';
import { MarketDataNotSettledError, runScreener } from './run';

// Fake market client that only publishes bars up to a configured "latest settled" date.
// Mimics the real-world condition the assertion is meant to catch: cron fires before
// Polygon has finalized the daily aggregate for runDate, so the most recent settled
// bar is from a prior session.
function makeFakeClient(latestSettled: string): MarketDataClient {
  return {
    async getGroupedDailyBars(date: string): Promise<DailyBar[]> {
      if (date > latestSettled) return [];
      return [
        {
          ticker: 'FAKE',
          date,
          open: 100,
          high: 101,
          low: 99,
          close: 100,
          volume: 1_000_000
        }
      ];
    },
    async getTickerDailyBars(): Promise<DailyBar[]> {
      return [];
    },
    async getTickerDetails(): Promise<TickerDetails | null> {
      return null;
    },
    async getNews(): Promise<NewsItem[]> {
      return [];
    },
    async getCorporateActions(): Promise<CorporateActionResult> {
      return { splits: [], dividends: [] };
    }
  };
}

describe('runScreener clock assertion', () => {
  it('throws MarketDataNotSettledError when latest settled bar is older than runDate', async () => {
    const runDate = '2026-05-11';
    const lastSettled = businessDatesBack(runDate, 2)[0];
    const client = makeFakeClient(lastSettled);

    await expect(runScreener(runDate, { client })).rejects.toBeInstanceOf(MarketDataNotSettledError);
  });

  it('exposes runDate and dataDate on the error so callers can log a skipped reason', async () => {
    const runDate = '2026-05-11';
    const lastSettled = businessDatesBack(runDate, 2)[0];
    const client = makeFakeClient(lastSettled);

    try {
      await runScreener(runDate, { client });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MarketDataNotSettledError);
      const e = err as MarketDataNotSettledError;
      expect(e.runDate).toBe(runDate);
      expect(e.dataDate).toBe(lastSettled);
    }
  });

  it('does not throw when requireSettled=false (smoke/historical mode)', async () => {
    const runDate = '2026-05-11';
    const lastSettled = businessDatesBack(runDate, 2)[0];
    const client = makeFakeClient(lastSettled);

    const result = await runScreener(runDate, { client, requireSettled: false });
    expect(result.dataDate).toBe(lastSettled);
  });

  it('attaches diagnostics to MarketDataNotSettledError including provider error samples', async () => {
    const runDate = '2026-05-11';
    const errorMessage = 'POLYGON_NOT_AUTHORIZED 403 /v2/aggs/grouped: not authorized';
    const failingClient: MarketDataClient = {
      async getGroupedDailyBars(date: string): Promise<DailyBar[]> {
        if (date === runDate) {
          throw new Error(errorMessage);
        }
        return [
          {
            ticker: 'FAKE',
            date,
            open: 100,
            high: 101,
            low: 99,
            close: 100,
            volume: 1_000_000
          }
        ];
      },
      async getTickerDailyBars(): Promise<DailyBar[]> {
        return [];
      },
      async getTickerDetails(): Promise<TickerDetails | null> {
        return null;
      },
      async getNews(): Promise<NewsItem[]> {
        return [];
      },
      async getCorporateActions(): Promise<CorporateActionResult> {
        return { splits: [], dividends: [] };
      }
    };

    try {
      await runScreener(runDate, { client: failingClient });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MarketDataNotSettledError);
      const e = err as MarketDataNotSettledError;
      expect(e.diagnostics.requestedRunDate).toBe(runDate);
      expect(e.diagnostics.windowError).toBeGreaterThan(0);
      expect(e.diagnostics.errorSamples.some((s) => s.includes('POLYGON_NOT_AUTHORIZED'))).toBe(true);
    }
  });

  it('returns full diagnostics on a successful run', async () => {
    const runDate = '2026-05-11';
    const client = makeFakeClient(runDate);
    const result = await runScreener(runDate, { client });
    expect(result.diagnostics.requestedRunDate).toBe(runDate);
    expect(result.diagnostics.latestAvailableDate).toBe(runDate);
    expect(result.diagnostics.windowOk).toBeGreaterThan(0);
    expect(result.diagnostics.freshnessMode).toBeDefined();
  });
});
