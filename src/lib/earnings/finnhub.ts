import { env } from '@/lib/env';
import { timedFetch } from '@/lib/utils/timed-fetch';
import { KeywordFallbackEarningsClient } from './keyword-fallback';
import type { EarningsCalendarClient, EarningsCheckResult } from './client';

interface FinnhubEarning {
  date?: string;
  symbol?: string;
  hour?: string;
  epsActual?: number | null;
  epsEstimate?: number | null;
}

interface FinnhubResponse {
  earningsCalendar?: FinnhubEarning[];
}

// Real earnings calendar via Finnhub. Activated by EARNINGS_CALENDAR_PROVIDER=finnhub
// + FINNHUB_API_KEY. Endpoint docs:
// https://finnhub.io/docs/api/earnings-calendar
//
// On any provider failure we fall through to the keyword-fallback path. The
// pre_flags row records earnings_source='keyword_fallback' in that case, which
// is the explicit-provenance behavior PR 3 promised: a missing-key or vendor
// outage must never look like a successful real-calendar check.
export class FinnhubEarningsClient implements EarningsCalendarClient {
  private readonly fallback = new KeywordFallbackEarningsClient();

  async checkEarningsWindow(args: { ticker: string; fromDate: string; toDate: string; news: import('@/types/app').NewsItem[] }): Promise<EarningsCheckResult> {
    if (!env.finnhubApiKey) {
      return this.fallback.checkEarningsWindow(args);
    }

    const url = new URL(`${env.finnhubBaseUrl}/calendar/earnings`);
    url.searchParams.set('from', args.fromDate);
    url.searchParams.set('to', args.toDate);
    url.searchParams.set('symbol', args.ticker);
    url.searchParams.set('token', env.finnhubApiKey);

    let body: FinnhubResponse;
    try {
      const res = await timedFetch(url, {
        headers: { accept: 'application/json' },
        timeoutMs: env.fetchTimeoutMs
      });
      if (!res.ok) {
        return this.fallback.checkEarningsWindow(args);
      }
      body = (await res.json()) as FinnhubResponse;
    } catch {
      return this.fallback.checkEarningsWindow(args);
    }

    const events = (body.earningsCalendar ?? []).filter((e) => {
      if (!e.date || !e.symbol) return false;
      if (e.symbol.toUpperCase() !== args.ticker.toUpperCase()) return false;
      return e.date >= args.fromDate && e.date <= args.toDate;
    });

    if (events.length === 0) {
      return {
        hasEarningsWithin: false,
        source: 'finnhub',
        nextEarningsDate: null,
        detail: 'finnhub: no earnings event in window'
      };
    }

    const earliest = events.map((e) => e.date as string).sort()[0];
    return {
      hasEarningsWithin: true,
      source: 'finnhub',
      nextEarningsDate: earliest,
      detail: `finnhub: earnings scheduled ${earliest}`
    };
  }
}
