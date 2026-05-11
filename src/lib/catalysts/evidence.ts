import { calendarDaysBack } from '@/lib/utils/dates';
import type { MarketDataClient } from '@/lib/market/client';
import type { NewsItem, ScreenedCandidate } from '@/types/app';

export interface CatalystEvidence {
  ticker: string;
  screenDate: string;
  candidate: {
    screenSource: string;
    pctChange: number;
    pctChange5d: number;
    relVolume: number;
    price: number;
    previousClose: number;
    marketCap: number;
    sector: string | null;
  };
  news: NewsItem[];
  sourceNotes: string[];
}

export async function buildCatalystEvidence(candidate: ScreenedCandidate, client: MarketDataClient): Promise<CatalystEvidence> {
  const fromDate = calendarDaysBack(candidate.date, 7);
  const news = await client.getNews(candidate.ticker, fromDate, 12).catch(() => []);
  return {
    ticker: candidate.ticker,
    screenDate: candidate.date,
    candidate: {
      screenSource: candidate.screenSource,
      pctChange: candidate.pctChange,
      pctChange5d: candidate.pctChange5d,
      relVolume: candidate.relVolume,
      price: candidate.price,
      previousClose: candidate.previousClose,
      marketCap: candidate.marketCap,
      sector: candidate.sector
    },
    news,
    sourceNotes: ['MVP evidence packet: price/volume metrics + last seven days of vendor news. Full EDGAR parser deferred to Phase 1B.']
  };
}

export function compactEvidenceForPrompt(evidence: CatalystEvidence): string {
  const newsLines = evidence.news.length
    ? evidence.news
        .slice(0, 8)
        .map((n, i) => `${i + 1}. ${n.publishedUtc.slice(0, 10)} - ${n.title}${n.description ? ` - ${n.description.slice(0, 220)}` : ''}`)
        .join('\n')
    : 'No recent vendor news returned.';

  return [
    `Ticker: ${evidence.ticker}`,
    `Screen date: ${evidence.screenDate}`,
    `Screen: ${evidence.candidate.screenSource}`,
    `Price: ${evidence.candidate.price}`,
    `Pct change 1d: ${evidence.candidate.pctChange.toFixed(2)}%`,
    `Pct change 5d: ${evidence.candidate.pctChange5d.toFixed(2)}%`,
    `Relative volume: ${evidence.candidate.relVolume.toFixed(2)}x`,
    `Market cap: ${Math.round(evidence.candidate.marketCap).toLocaleString()}`,
    `Sector: ${evidence.candidate.sector ?? 'unknown'}`,
    '',
    'Recent news:',
    newsLines
  ].join('\n');
}
