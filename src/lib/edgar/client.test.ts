import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _internal, _resetEdgarCacheForTests, checkRecentOfferingFiling } from './client';

const TICKER_MAP_BODY = {
  '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc' },
  '1': { cik_str: 789019, ticker: 'MSFT', title: 'Microsoft Corp' }
};

interface MockResponseBody {
  url: RegExp;
  body: unknown;
  status?: number;
}

function installFetchMock(responses: MockResponseBody[]) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    for (const r of responses) {
      if (r.url.test(url)) {
        return new Response(JSON.stringify(r.body), {
          status: r.status ?? 200,
          headers: { 'content-type': 'application/json' }
        });
      }
    }
    return new Response(JSON.stringify({ error: 'unmocked', url }), { status: 404 });
  });
}

beforeEach(() => {
  _resetEdgarCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('checkRecentOfferingFiling', () => {
  it('detects a 424B5 filing in the lookback window', async () => {
    installFetchMock([
      { url: /company_tickers\.json/, body: TICKER_MAP_BODY },
      {
        url: /submissions\/CIK0000320193\.json/,
        body: {
          filings: {
            recent: {
              form: ['10-Q', '424B5', '8-K'],
              filingDate: ['2026-04-15', '2026-05-09', '2026-05-10'],
              accessionNumber: ['000', '111', '222'],
              primaryDocument: ['a.htm', 'b.htm', 'c.htm']
            }
          }
        }
      }
    ]);

    const result = await checkRecentOfferingFiling({
      ticker: 'AAPL',
      fromDate: '2026-04-15',
      toDate: '2026-05-11'
    });

    expect(result.hasRecentFiling).toBe(true);
    expect(result.formType).toBe('424B5');
    expect(result.filingDate).toBe('2026-05-09');
  });

  it('returns no signal when filings exist but none are offering forms', async () => {
    installFetchMock([
      { url: /company_tickers\.json/, body: TICKER_MAP_BODY },
      {
        url: /submissions\/CIK0000320193\.json/,
        body: {
          filings: {
            recent: {
              form: ['10-Q', '8-K', '4'],
              filingDate: ['2026-04-15', '2026-05-09', '2026-05-10'],
              accessionNumber: ['000', '111', '222'],
              primaryDocument: ['a.htm', 'b.htm', 'c.htm']
            }
          }
        }
      }
    ]);

    const result = await checkRecentOfferingFiling({
      ticker: 'AAPL',
      fromDate: '2026-04-15',
      toDate: '2026-05-11'
    });
    expect(result.hasRecentFiling).toBe(false);
    expect(result.formType).toBeNull();
    expect(result.totalRecentFilings).toBe(3);
  });

  it('returns the latest matching filing when multiple offering forms appear', async () => {
    installFetchMock([
      { url: /company_tickers\.json/, body: TICKER_MAP_BODY },
      {
        url: /submissions\/CIK0000320193\.json/,
        body: {
          filings: {
            recent: {
              form: ['S-3', '424B5'],
              filingDate: ['2026-04-20', '2026-05-09'],
              accessionNumber: ['000', '111'],
              primaryDocument: ['s.htm', 'b.htm']
            }
          }
        }
      }
    ]);
    const result = await checkRecentOfferingFiling({
      ticker: 'AAPL',
      fromDate: '2026-04-15',
      toDate: '2026-05-11'
    });
    expect(result.hasRecentFiling).toBe(true);
    expect(result.formType).toBe('424B5');
    expect(result.filingDate).toBe('2026-05-09');
  });

  it('treats a missing CIK as no signal, not as an error', async () => {
    installFetchMock([{ url: /company_tickers\.json/, body: TICKER_MAP_BODY }]);
    const result = await checkRecentOfferingFiling({
      ticker: 'NOPE',
      fromDate: '2026-04-15',
      toDate: '2026-05-11'
    });
    expect(result.hasRecentFiling).toBe(false);
    expect(result.notes).toBe('edgar_no_cik_for_ticker');
  });

  it('treats an EDGAR submissions error as no signal with a descriptive note', async () => {
    installFetchMock([
      { url: /company_tickers\.json/, body: TICKER_MAP_BODY },
      { url: /submissions\/CIK0000320193\.json/, body: { error: 'boom' }, status: 500 }
    ]);
    const result = await checkRecentOfferingFiling({
      ticker: 'AAPL',
      fromDate: '2026-04-15',
      toDate: '2026-05-11'
    });
    expect(result.hasRecentFiling).toBe(false);
    expect(result.notes).toMatch(/edgar_submissions_unavailable/);
  });

  it('treats a CIK-map fetch failure as no signal', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('boom', { status: 500 }));
    const result = await checkRecentOfferingFiling({
      ticker: 'AAPL',
      fromDate: '2026-04-15',
      toDate: '2026-05-11'
    });
    expect(result.hasRecentFiling).toBe(false);
    expect(result.notes).toMatch(/edgar_cik_map_unavailable/);
  });

  it('isOfferingForm recognizes the documented prefixes', () => {
    expect(_internal.isOfferingForm('424B5')).toBe(true);
    expect(_internal.isOfferingForm('FWP')).toBe(true);
    expect(_internal.isOfferingForm('S-1')).toBe(true);
    expect(_internal.isOfferingForm('S-3/A')).toBe(true);
    expect(_internal.isOfferingForm('10-Q')).toBe(false);
    expect(_internal.isOfferingForm('8-K')).toBe(false);
  });
});
