import { addDays, businessDatesBack } from '@/lib/utils/dates';
import type { CorporateActionResult, DailyBar, NewsItem, TickerDetails } from '@/types/app';
import type { MarketDataClient } from './client';

const tickers = ['AAPL', 'MSFT', 'TSLA', 'DBX', 'SHOP', 'NFLX', 'PANW', 'ADBE', 'CRWD', 'AMD'];

function seededNoise(seed: number): number {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function priceFor(ticker: string, idx: number, base: number): number {
  const t = ticker.split('').reduce((sum, c) => sum + c.charCodeAt(0), 0);
  const drift = idx * 0.15;
  const wiggle = (seededNoise(t * 17 + idx * 13) - 0.5) * 3;
  return Math.max(8, base + drift + wiggle);
}

export class MockMarketDataClient implements MarketDataClient {
  async getGroupedDailyBars(date: string): Promise<DailyBar[]> {
    const dates = businessDatesBack(date, 30);
    const idx = Math.max(0, dates.indexOf(date));
    return tickers.map((ticker, i) => {
      const base = 35 + i * 22;
      let close = priceFor(ticker, idx, base);
      let open = close * (1 + (seededNoise(i + idx) - 0.5) * 0.02);
      let volume = 1_000_000 + i * 450_000;

      // Make a few obvious bounce candidates on the latest day.
      if (idx === dates.length - 1 && ['DBX', 'SHOP', 'PANW', 'AMD'].includes(ticker)) {
        close *= ticker === 'SHOP' ? 0.86 : 0.91;
        open = close * 1.04;
        volume *= ticker === 'SHOP' ? 4.2 : 2.4;
      }

      const high = Math.max(open, close) * 1.025;
      const low = Math.min(open, close) * 0.975;
      return {
        ticker,
        date,
        open: Number(open.toFixed(2)),
        high: Number(high.toFixed(2)),
        low: Number(low.toFixed(2)),
        close: Number(close.toFixed(2)),
        volume: Math.round(volume),
        vwap: Number(((open + close) / 2).toFixed(2)),
        transactions: 10000 + i * 1000
      };
    });
  }

  async getTickerDailyBars(ticker: string, from: string, to: string): Promise<DailyBar[]> {
    const dates = businessDatesBack(to, 35).filter((d) => d >= from && d <= to);
    const all = await Promise.all(dates.map((d) => this.getGroupedDailyBars(d)));
    return all.flat().filter((b) => b.ticker === ticker);
  }

  async getTickerDetails(ticker: string): Promise<TickerDetails | null> {
    const i = Math.max(0, tickers.indexOf(ticker));
    return {
      ticker,
      name: `${ticker} Mock Corporation`,
      marketCap: 3_000_000_000 + i * 6_000_000_000,
      sector: i % 2 === 0 ? 'Technology' : 'Consumer Discretionary',
      primaryExchange: i % 2 === 0 ? 'XNAS' : 'XNYS',
      type: 'CS',
      locale: 'us',
      country: 'US',
      active: true
    };
  }

  async getNews(ticker: string, fromDate: string, limit = 10): Promise<NewsItem[]> {
    const templates: Record<string, string[]> = {
      DBX: ['Analyst reiterates buy rating after software selloff', 'Company announces new enterprise features'],
      SHOP: ['Shares fall after guidance update, no offering announced', 'E-commerce sector weakens on macro fears'],
      PANW: ['Cybersecurity group trades lower after sector rotation'],
      AMD: ['Semiconductor stocks slide on broad chip weakness']
    };
    return (templates[ticker] ?? [`${ticker} stock moves lower with market`]).slice(0, limit).map((title, idx) => ({
      ticker,
      title,
      description: `${title}. Mock news item for local smoke tests.`,
      articleUrl: 'https://example.com/mock-news',
      publishedUtc: `${addDays(fromDate, idx)}T14:00:00Z`,
      publisherName: 'MockWire',
      tickers: [ticker]
    }));
  }

  async getCorporateActions(): Promise<CorporateActionResult> {
    return { splits: [], dividends: [] };
  }
}
