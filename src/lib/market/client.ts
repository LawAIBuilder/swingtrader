import type { CorporateActionResult, DailyBar, NewsItem, TickerDetails } from '@/types/app';

export interface MarketDataClient {
  getGroupedDailyBars(date: string): Promise<DailyBar[]>;
  getTickerDailyBars(ticker: string, from: string, to: string): Promise<DailyBar[]>;
  getTickerDetails(ticker: string): Promise<TickerDetails | null>;
  getNews(ticker: string, fromDate: string, limit?: number): Promise<NewsItem[]>;
  getCorporateActions(ticker: string, fromDate: string, toDate: string): Promise<CorporateActionResult>;
}
