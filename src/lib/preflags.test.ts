import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CandidateRow,
  CorporateActionResult,
  NewsItem,
  ScreenedCandidate,
  TickerDetails
} from '@/types/app';
import type { OfferingCheckResult } from '@/lib/edgar/client';

vi.mock('@/lib/supabase/admin', () => ({
  // wash_sale_lockout query: chained .from(...).select(...).eq(...).gte(...).limit(...)
  // Returns { data: [], error: null } in all tests so the lockout never fires.
  getSupabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          gte: () => ({
            limit: () => Promise.resolve({ data: [], error: null })
          })
        })
      })
    })
  })
}));

vi.mock('@/lib/earnings/provider', async () => {
  // Lazy import the real provider implementation so we can configure the mock
  // per-test by overriding what getEarningsCalendarClient returns.
  const realModule = await vi.importActual<typeof import('@/lib/earnings/provider')>('@/lib/earnings/provider');
  return {
    ...realModule,
    getEarningsCalendarClient: () => ({
      checkEarningsWindow: async () =>
        // Default mock: keyword-fallback-shaped, no earnings detected. Tests
        // that exercise the BLACKOUT path use vi.mocked to swap this out.
        ({ hasEarningsWithin: false, source: 'keyword_fallback' as const, nextEarningsDate: null, detail: 'mock: none' })
    })
  };
});

const { evaluatePreFlags } = await import('./preflags');
const earningsProvider = await import('@/lib/earnings/provider');

function buildCandidate(overrides: Partial<ScreenedCandidate> = {}): ScreenedCandidate {
  const details: TickerDetails = {
    ticker: 'TEST',
    name: 'Test Corp',
    marketCap: 8_000_000_000,
    sector: 'Technology',
    primaryExchange: 'XNAS',
    type: 'CS',
    locale: 'us',
    country: 'US',
    active: true
  };
  const latestBar = {
    ticker: 'TEST',
    date: '2026-05-11',
    open: 100,
    high: 102,
    low: 95,
    close: 96,
    volume: 5_000_000,
    vwap: 98,
    transactions: 20_000
  };
  return {
    ticker: 'TEST',
    date: '2026-05-11',
    latestBar,
    previousClose: 105,
    pctChange: -8.5,
    pctChange5d: -10,
    relVolume: 2.1,
    avgVolume20d: 2_500_000,
    avgDollarVolume20d: 250_000_000,
    atr14: 4,
    drawdownFrom20dHighPct: -12,
    signalDayLow: 94,
    screenSource: 'screen_a',
    details,
    sector: 'Technology',
    marketCap: 8_000_000_000,
    price: 96,
    ...overrides
  };
}

function buildCandidateRow(overrides: Partial<CandidateRow> = {}): CandidateRow {
  return {
    id: 1,
    ticker: 'TEST',
    screen_date: '2026-05-11',
    screen_source: 'screen_a',
    pct_change: -8.5,
    volume: 5_000_000,
    rel_volume: 2.1,
    market_cap: 8_000_000_000,
    price: 96,
    prev_close: 105,
    sector: 'Technology',
    ...overrides
  };
}

function newsItem(title: string, description = ''): NewsItem {
  return {
    ticker: 'TEST',
    title,
    description,
    publishedUtc: '2026-05-11T13:00:00Z',
    publisherName: 'TestWire',
    tickers: ['TEST']
  };
}

const noCorpActions: CorporateActionResult = { splits: [], dividends: [] };

beforeEach(() => {
  vi.spyOn(earningsProvider, 'getEarningsCalendarClient').mockReturnValue({
    checkEarningsWindow: async () => ({
      hasEarningsWithin: false,
      source: 'keyword_fallback',
      nextEarningsDate: null,
      detail: 'mock: none'
    })
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('evaluatePreFlags - PR 3 fixtures', () => {
  it('real offering phrase -> AVOID with offering_source=keyword', async () => {
    const flags = await evaluatePreFlags({
      candidate: buildCandidate(),
      persistedCandidate: buildCandidateRow(),
      news: [newsItem('Company prices public offering of $250M at $90 per share')],
      corporateActions: noCorpActions,
      offering: { hasRecentFiling: false, formType: null, filingDate: null, totalRecentFilings: 0, notes: 'mock' }
    });
    expect(flags.has_recent_offering).toBe(true);
    expect(flags.offering_source).toBe('keyword');
    expect(flags.auto_disposition).toBe('AVOID');
  });

  it('negated offering phrase -> not AVOID', async () => {
    const flags = await evaluatePreFlags({
      candidate: buildCandidate(),
      persistedCandidate: buildCandidateRow(),
      news: [newsItem('CFO confirms no offering planned and no plans for dilution this year')],
      corporateActions: noCorpActions,
      offering: { hasRecentFiling: false, formType: null, filingDate: null, totalRecentFilings: 0, notes: 'mock' }
    });
    expect(flags.has_recent_offering).toBe(false);
    expect(flags.offering_source).toBe('none');
    expect(flags.auto_disposition).toBe('OK_FOR_AI');
  });

  it('dividend suspension -> AVOID', async () => {
    const flags = await evaluatePreFlags({
      candidate: buildCandidate(),
      persistedCandidate: buildCandidateRow(),
      news: [newsItem('Board suspends dividend amid restructuring')],
      corporateActions: noCorpActions,
      offering: null
    });
    expect(flags.dividend_suspended).toBe(true);
    expect(flags.auto_disposition).toBe('AVOID');
  });

  it('negated dividend phrase -> not AVOID', async () => {
    const flags = await evaluatePreFlags({
      candidate: buildCandidate(),
      persistedCandidate: buildCandidateRow(),
      news: [newsItem('CEO: company has not suspended dividend, will continue payout')],
      corporateActions: noCorpActions,
      offering: null
    });
    expect(flags.dividend_suspended).toBe(false);
    expect(flags.auto_disposition).toBe('OK_FOR_AI');
  });

  it('keyword earnings fallback -> BLACKOUT with earnings_source=keyword_fallback', async () => {
    vi.mocked(earningsProvider.getEarningsCalendarClient).mockReturnValue({
      checkEarningsWindow: async () => ({
        hasEarningsWithin: true,
        source: 'keyword_fallback',
        nextEarningsDate: null,
        detail: 'keyword match: "to report earnings"'
      })
    });
    const flags = await evaluatePreFlags({
      candidate: buildCandidate(),
      persistedCandidate: buildCandidateRow(),
      news: [newsItem('Company to report earnings on Thursday')],
      corporateActions: noCorpActions,
      offering: null
    });
    expect(flags.earnings_within_5d).toBe(true);
    expect(flags.earnings_source).toBe('keyword_fallback');
    expect(flags.auto_disposition).toBe('BLACKOUT');
    expect(flags.reasons).toContain('earnings_blackout:keyword_fallback');
  });

  it('real-calendar positive -> BLACKOUT with earnings_source=finnhub', async () => {
    vi.mocked(earningsProvider.getEarningsCalendarClient).mockReturnValue({
      checkEarningsWindow: async () => ({
        hasEarningsWithin: true,
        source: 'finnhub',
        nextEarningsDate: '2026-05-13',
        detail: 'finnhub: earnings scheduled 2026-05-13'
      })
    });
    const flags = await evaluatePreFlags({
      candidate: buildCandidate(),
      persistedCandidate: buildCandidateRow(),
      news: [],
      corporateActions: noCorpActions,
      offering: null
    });
    expect(flags.earnings_within_5d).toBe(true);
    expect(flags.earnings_source).toBe('finnhub');
    expect(flags.auto_disposition).toBe('BLACKOUT');
  });

  it('real-calendar negative -> not BLACKOUT even when news has the keyword', async () => {
    // Provider says no earnings; the real-calendar answer overrides keyword
    // suspicion since it's the higher-confidence source.
    vi.mocked(earningsProvider.getEarningsCalendarClient).mockReturnValue({
      checkEarningsWindow: async () => ({
        hasEarningsWithin: false,
        source: 'finnhub',
        nextEarningsDate: null,
        detail: 'finnhub: no earnings event in window'
      })
    });
    const flags = await evaluatePreFlags({
      candidate: buildCandidate(),
      persistedCandidate: buildCandidateRow(),
      news: [newsItem('Recap: company reports earnings on Thursday', 'last-quarter recap article')],
      corporateActions: noCorpActions,
      offering: null
    });
    expect(flags.earnings_within_5d).toBe(false);
    expect(flags.earnings_source).toBe('finnhub');
    expect(flags.auto_disposition).toBe('OK_FOR_AI');
  });

  it('split in lookback window -> SKIP with corp_action_in_window=true', async () => {
    const flags = await evaluatePreFlags({
      candidate: buildCandidate(),
      persistedCandidate: buildCandidateRow(),
      news: [newsItem('Routine business update, nothing material')],
      corporateActions: {
        splits: [{ executionDate: '2026-05-08', splitFrom: 1, splitTo: 4, raw: {} }],
        dividends: []
      },
      offering: null
    });
    expect(flags.corp_action_in_window).toBe(true);
    expect(flags.auto_disposition).toBe('SKIP');
    expect(flags.reasons).toContain('corp_action_in_lookback');
  });

  it('special dividend (SC) in window -> SKIP', async () => {
    const flags = await evaluatePreFlags({
      candidate: buildCandidate(),
      persistedCandidate: buildCandidateRow(),
      news: [],
      corporateActions: {
        splits: [],
        dividends: [{ exDividendDate: '2026-05-15', cashAmount: 5.0, dividendType: 'SC', raw: {} }]
      },
      offering: null
    });
    expect(flags.corp_action_in_window).toBe(true);
    expect(flags.auto_disposition).toBe('SKIP');
  });

  it('ordinary dividend (CD) in window -> NOT SKIP', async () => {
    const flags = await evaluatePreFlags({
      candidate: buildCandidate(),
      persistedCandidate: buildCandidateRow(),
      news: [],
      corporateActions: {
        splits: [],
        dividends: [{ exDividendDate: '2026-05-15', cashAmount: 0.25, dividendType: 'CD', raw: {} }]
      },
      offering: null
    });
    expect(flags.corp_action_in_window).toBe(false);
    expect(flags.auto_disposition).toBe('OK_FOR_AI');
  });

  it('EDGAR offering filing wins over keyword and stamps offering_source=edgar', async () => {
    const offering: OfferingCheckResult = {
      hasRecentFiling: true,
      formType: '424B5',
      filingDate: '2026-05-09',
      totalRecentFilings: 12,
      notes: 'edgar: 424B5 filed 2026-05-09'
    };
    const flags = await evaluatePreFlags({
      candidate: buildCandidate(),
      persistedCandidate: buildCandidateRow(),
      // No keyword in news; only EDGAR fires.
      news: [newsItem('Quarterly business review continues smoothly')],
      corporateActions: noCorpActions,
      offering
    });
    expect(flags.has_recent_offering).toBe(true);
    expect(flags.offering_source).toBe('edgar');
    expect(flags.auto_disposition).toBe('AVOID');
    expect(flags.reasons.some((r) => r.startsWith('recent_offering_edgar:424B5'))).toBe(true);
  });

  it('low liquidity dominates -> SKIP regardless of other signals', async () => {
    const flags = await evaluatePreFlags({
      candidate: buildCandidate({ price: 5, marketCap: 100_000_000, avgDollarVolume20d: 1_000_000 }),
      persistedCandidate: buildCandidateRow({ price: 5 }),
      news: [newsItem('Company prices public offering')],
      corporateActions: noCorpActions,
      offering: null
    });
    expect(flags.liquidity_ok).toBe(false);
    expect(flags.auto_disposition).toBe('SKIP');
  });
});
