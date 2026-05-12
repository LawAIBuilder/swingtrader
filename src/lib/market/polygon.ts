import { env, requireEnv } from '@/lib/env';
import { timedFetch } from '@/lib/utils/timed-fetch';
import type { CorporateActionResult, DailyBar, DividendType, NewsItem, TickerDetails } from '@/types/app';
import type { MarketDataClient } from './client';

function parseDividendType(value: unknown): DividendType {
  if (value === 'CD' || value === 'SC' || value === 'LT' || value === 'ST') return value;
  return 'unknown';
}

interface PolygonGroupedAgg {
  T: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  vw?: number;
  n?: number;
  t: number;
}

interface PolygonResponse<T> {
  status?: string;
  results?: T;
  resultsCount?: number;
  count?: number;
  next_url?: string;
  error?: string;
  message?: string;
}

function dateFromMillis(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/$/, '');
}

export class PolygonClient implements MarketDataClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor() {
    this.baseUrl = normalizeBaseUrl(env.polygonBaseUrl);
    this.apiKey = requireEnv('POLYGON_API_KEY', env.polygonApiKey);
  }

  private async request<T>(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<PolygonResponse<T>> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value != null && value !== '') url.searchParams.set(key, String(value));
    }
    url.searchParams.set('apiKey', this.apiKey);

    let lastError: Error | null = null;
    let lastStatus: number | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const res = await timedFetch(url, {
          headers: { accept: 'application/json' },
          timeoutMs: env.fetchTimeoutMs
        });
        const json = (await res.json().catch(() => ({}))) as PolygonResponse<T>;
        if (!res.ok) {
          lastStatus = res.status;
          // Normalize the most common free-tier failure (current-day grouped
          // bars on a plan that does not include them). Polygon returns
          // status:"NOT_AUTHORIZED" with HTTP 403. We tag it explicitly so
          // diagnostics can surface "upgrade plan" rather than a generic
          // 403 message.
          const upstreamStatus = json.status ?? '';
          const message = json.error ?? json.message ?? res.statusText;
          if (res.status === 403 || upstreamStatus === 'NOT_AUTHORIZED') {
            throw new Error(`POLYGON_NOT_AUTHORIZED ${res.status} ${path}: ${message}`);
          }
          if (res.status === 429) {
            throw new Error(`POLYGON_RATE_LIMITED ${res.status} ${path}: ${message}`);
          }
          throw new Error(`Polygon request failed ${res.status} ${path}: ${message}`);
        }
        return json;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // Don't retry auth/quota failures - they will keep returning the same
        // answer and we want to surface them quickly in diagnostics.
        if (lastStatus === 403 || lastStatus === 401) break;
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
    throw lastError ?? new Error('Polygon request failed');
  }

  async getGroupedDailyBars(date: string): Promise<DailyBar[]> {
    const json = await this.request<PolygonGroupedAgg[]>(`/v2/aggs/grouped/locale/us/market/stocks/${date}`, {
      adjusted: true,
      include_otc: false
    });
    const results = json.results ?? [];
    return results.map((r) => ({
      ticker: r.T,
      date: dateFromMillis(r.t),
      open: r.o,
      high: r.h,
      low: r.l,
      close: r.c,
      volume: r.v,
      vwap: r.vw ?? null,
      transactions: r.n ?? null
    }));
  }

  async getTickerDailyBars(ticker: string, from: string, to: string): Promise<DailyBar[]> {
    const json = await this.request<PolygonGroupedAgg[]>(`/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${from}/${to}`, {
      adjusted: true,
      sort: 'asc',
      limit: 5000
    });
    const results = json.results ?? [];
    return results.map((r) => ({
      ticker,
      date: dateFromMillis(r.t),
      open: r.o,
      high: r.h,
      low: r.l,
      close: r.c,
      volume: r.v,
      vwap: r.vw ?? null,
      transactions: r.n ?? null
    }));
  }

  async getTickerDetails(ticker: string): Promise<TickerDetails | null> {
    const json = await this.request<Record<string, unknown>>(`/v3/reference/tickers/${encodeURIComponent(ticker)}`);
    const r = json.results;
    if (!r) return null;
    const address = (r.address ?? {}) as Record<string, unknown>;
    return {
      ticker: String(r.ticker ?? ticker),
      name: typeof r.name === 'string' ? r.name : null,
      marketCap: typeof r.market_cap === 'number' ? r.market_cap : null,
      sector: typeof r.sic_description === 'string' ? r.sic_description : null,
      sicDescription: typeof r.sic_description === 'string' ? r.sic_description : null,
      primaryExchange: typeof r.primary_exchange === 'string' ? r.primary_exchange : null,
      type: typeof r.type === 'string' ? r.type : null,
      locale: typeof r.locale === 'string' ? r.locale : null,
      country: typeof address.country === 'string' ? address.country : null,
      active: typeof r.active === 'boolean' ? r.active : null
    };
  }

  async getNews(ticker: string, fromDate: string, limit = 10): Promise<NewsItem[]> {
    const json = await this.request<Array<Record<string, unknown>>>('/v2/reference/news', {
      ticker,
      'published_utc.gte': `${fromDate}T00:00:00Z`,
      order: 'desc',
      sort: 'published_utc',
      limit
    });
    const results = json.results ?? [];
    return results.map((r) => {
      const publisher = (r.publisher ?? {}) as Record<string, unknown>;
      return {
        id: typeof r.id === 'string' ? r.id : undefined,
        ticker,
        title: String(r.title ?? ''),
        description: typeof r.description === 'string' ? r.description : null,
        articleUrl: typeof r.article_url === 'string' ? r.article_url : null,
        publishedUtc: String(r.published_utc ?? ''),
        publisherName: typeof publisher.name === 'string' ? publisher.name : null,
        tickers: Array.isArray(r.tickers) ? (r.tickers as string[]) : [],
        insights: Array.isArray(r.insights) ? (r.insights as NewsItem['insights']) : []
      };
    });
  }

  async getCorporateActions(ticker: string, fromDate: string, toDate: string): Promise<CorporateActionResult> {
    const [splitsJson, dividendsJson] = await Promise.all([
      this.request<Array<Record<string, unknown>>>('/v3/reference/splits', {
        ticker,
        'execution_date.gte': fromDate,
        'execution_date.lte': toDate,
        limit: 100
      }).catch(() => ({ results: [] })),
      this.request<Array<Record<string, unknown>>>('/v3/reference/dividends', {
        ticker,
        'ex_dividend_date.gte': fromDate,
        'ex_dividend_date.lte': toDate,
        limit: 100
      }).catch(() => ({ results: [] }))
    ]);

    return {
      splits: (splitsJson.results ?? []).map((r) => ({
        executionDate: typeof r.execution_date === 'string' ? r.execution_date : undefined,
        splitFrom: typeof r.split_from === 'number' ? r.split_from : undefined,
        splitTo: typeof r.split_to === 'number' ? r.split_to : undefined,
        raw: r
      })),
      dividends: (dividendsJson.results ?? []).map((r) => ({
        exDividendDate: typeof r.ex_dividend_date === 'string' ? r.ex_dividend_date : undefined,
        cashAmount: typeof r.cash_amount === 'number' ? r.cash_amount : undefined,
        dividendType: parseDividendType(r.dividend_type),
        raw: r
      }))
    };
  }
}
