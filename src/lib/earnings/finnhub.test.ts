import { afterEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted runs BEFORE the import statements below are resolved, which is
// required because env.ts captures process.env at module load. Setting the
// env vars inline at the top of the file would execute too late under ESM.
vi.hoisted(() => {
  process.env.FINNHUB_API_KEY = 'test-key-123';
  process.env.FINNHUB_BASE_URL = 'https://finnhub.io/api/v1';
});

import { FinnhubEarningsClient } from './finnhub';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FinnhubEarningsClient', () => {
  it('reports earnings within window when Finnhub returns a matching event', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          earningsCalendar: [
            { symbol: 'TEST', date: '2026-05-13', hour: 'amc', epsActual: null, epsEstimate: 0.42 }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    const client = new FinnhubEarningsClient();
    const result = await client.checkEarningsWindow({
      ticker: 'TEST',
      fromDate: '2026-05-11',
      toDate: '2026-05-15',
      news: []
    });

    expect(result.hasEarningsWithin).toBe(true);
    expect(result.source).toBe('finnhub');
    expect(result.nextEarningsDate).toBe('2026-05-13');
  });

  it('reports no earnings with source=finnhub when the calendar is empty', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ earningsCalendar: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

    const client = new FinnhubEarningsClient();
    const result = await client.checkEarningsWindow({
      ticker: 'TEST',
      fromDate: '2026-05-11',
      toDate: '2026-05-15',
      news: []
    });

    expect(result.hasEarningsWithin).toBe(false);
    expect(result.source).toBe('finnhub');
    expect(result.nextEarningsDate).toBeNull();
  });

  it('ignores events for a different symbol', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          earningsCalendar: [
            { symbol: 'OTHER', date: '2026-05-13' },
            { symbol: 'TEST', date: '2026-06-01' }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    const client = new FinnhubEarningsClient();
    const result = await client.checkEarningsWindow({
      ticker: 'TEST',
      fromDate: '2026-05-11',
      toDate: '2026-05-15',
      news: []
    });

    expect(result.hasEarningsWithin).toBe(false);
    expect(result.source).toBe('finnhub');
  });

  it('falls through to keyword fallback on a Finnhub HTTP error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));

    const client = new FinnhubEarningsClient();
    const result = await client.checkEarningsWindow({
      ticker: 'TEST',
      fromDate: '2026-05-11',
      toDate: '2026-05-15',
      news: [
        {
          ticker: 'TEST',
          title: 'TEST to report earnings on Thursday',
          publishedUtc: '2026-05-11T12:00:00Z'
        }
      ]
    });

    expect(result.source).toBe('keyword_fallback');
    expect(result.hasEarningsWithin).toBe(true);
  });

  it('falls through to keyword fallback on a network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNRESET'));

    const client = new FinnhubEarningsClient();
    const result = await client.checkEarningsWindow({
      ticker: 'TEST',
      fromDate: '2026-05-11',
      toDate: '2026-05-15',
      news: []
    });

    expect(result.source).toBe('keyword_fallback');
    expect(result.hasEarningsWithin).toBe(false);
  });
});
