import { matchKeywords } from '@/lib/text/match';
import type { NewsItem } from '@/types/app';
import type { EarningsCalendarClient, EarningsCheckResult } from './client';

// Conservative keyword set for "earnings within the next few days." We
// intentionally avoid generic phrases like "reports earnings" without a
// temporal qualifier (those frequently match earnings recaps from last
// quarter). matchKeywords' negation handling keeps things like "did not
// pre-announce earnings" out.
export const EARNINGS_BLACKOUT_TERMS: readonly string[] = [
  'reports earnings tomorrow',
  'reports quarterly results tomorrow',
  'reports earnings on',
  'reports quarterly results on',
  'to report earnings',
  'will report earnings',
  'earnings expected',
  'earnings scheduled',
  'announces earnings date',
  'earnings call scheduled'
];

function combineNewsText(news: NewsItem[]): string {
  return news.map((n) => `${n.title} ${n.description ?? ''}`).join(' ');
}

export class KeywordFallbackEarningsClient implements EarningsCalendarClient {
  async checkEarningsWindow(args: { ticker: string; fromDate: string; toDate: string; news: NewsItem[] }): Promise<EarningsCheckResult> {
    const text = combineNewsText(args.news);
    const result = matchKeywords(text, EARNINGS_BLACKOUT_TERMS);
    const hit = result.matches.find((m) => !m.negated);
    return {
      hasEarningsWithin: result.matched,
      source: 'keyword_fallback',
      nextEarningsDate: null,
      detail: hit ? `keyword match: "${hit.term}"` : 'no earnings keywords detected'
    };
  }
}
