import { env } from '@/lib/env';
import type { EarningsCalendarClient } from './client';
import { FinnhubEarningsClient } from './finnhub';
import { KeywordFallbackEarningsClient } from './keyword-fallback';

let cached: EarningsCalendarClient | null = null;

// Selects the earnings calendar implementation based on env. Any unrecognized
// EARNINGS_CALENDAR_PROVIDER value silently maps to keyword_fallback so a
// typo cannot cause production to behave like a real calendar check happened.
export function getEarningsCalendarClient(): EarningsCalendarClient {
  if (cached) return cached;
  if (env.earningsCalendarProvider === 'finnhub') {
    cached = new FinnhubEarningsClient();
  } else {
    cached = new KeywordFallbackEarningsClient();
  }
  return cached;
}

// Test seam.
export function _resetEarningsCalendarClientForTests(): void {
  cached = null;
}
