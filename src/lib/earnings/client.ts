import type { NewsItem } from '@/types/app';

// Provenance for the earnings detection. Stored in pre_flags.earnings_source
// so a 'keyword_fallback' row is never confused with a real-calendar answer.
export type EarningsSource = 'keyword_fallback' | 'finnhub';

export interface EarningsCheckResult {
  hasEarningsWithin: boolean;
  source: EarningsSource;
  // Vendor-reported earnings date if the provider has one. Always null on the
  // keyword fallback path (we have no calendar data, only headline language).
  nextEarningsDate: string | null;
  // Free-form provider note for debugging. Stored as part of pre_flags.reasons
  // so the dashboard can surface why a detection fired.
  detail: string;
}

export interface EarningsCalendarClient {
  checkEarningsWindow(args: {
    ticker: string;
    fromDate: string;
    toDate: string;
    news: NewsItem[];
  }): Promise<EarningsCheckResult>;
}
