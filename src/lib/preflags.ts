import { env } from '@/lib/env';
import { getEarningsCalendarClient } from '@/lib/earnings/provider';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { firstAffirmativeMatch, matchKeywords } from '@/lib/text/match';
import type {
  AutoDisposition,
  CandidateRow,
  CorporateActionResult,
  NewsItem,
  ScreenedCandidate
} from '@/types/app';
import type { EarningsSource } from '@/lib/earnings/client';
import type { OfferingCheckResult } from '@/lib/edgar/client';

export interface PreFlagResult {
  has_recent_offering: boolean;
  earnings_within_5d: boolean;
  dividend_suspended: boolean;
  liquidity_ok: boolean;
  wash_sale_lockout: boolean;
  corp_action_in_window: boolean;
  earnings_source: EarningsSource;
  offering_source: 'none' | 'keyword' | 'edgar';
  auto_disposition: AutoDisposition;
  reasons: string[];
}

// Keyword sets routed through the negation-aware matcher in src/lib/text/match.
// Negated forms ("no offering planned", "has not suspended dividend") no longer
// trip the affirmative branch.
export const OFFERING_TERMS: readonly string[] = [
  'secondary offering',
  'public offering',
  'share offering',
  'registered direct offering',
  'convertible notes',
  'convertible note',
  'at-the-market offering',
  'atm offering',
  'dilution',
  'prices offering',
  'pricing of public offering',
  'pricing of offering'
];

export const DIVIDEND_SUSPENSION_TERMS: readonly string[] = [
  'suspends dividend',
  'suspended dividend',
  'dividend suspension',
  'eliminates dividend',
  'cuts dividend to zero',
  'omits dividend'
];

export interface EvaluatePreFlagsInput {
  candidate: ScreenedCandidate;
  persistedCandidate: CandidateRow;
  news: NewsItem[];
  // Splits + dividends in [signal_date - lookback, signal_date + lookahead].
  // The screener fetches this once per candidate and passes it in so this
  // function stays pure and unit-testable.
  corporateActions: CorporateActionResult;
  // EDGAR offering-filing check result, or null if the screener disabled or
  // skipped the EDGAR call (e.g. on the mock data provider).
  offering: OfferingCheckResult | null;
}

function combineNewsText(news: NewsItem[]): string {
  return news.map((n) => `${n.title} ${n.description ?? ''}`).join(' ');
}

async function hasWashSaleLockout(ticker: string, date: string): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('wash_sale_lockout')
    .select('ticker, lockout_until')
    .eq('ticker', ticker)
    .gte('lockout_until', date)
    .limit(1);
  if (error) throw error;
  return Boolean(data && data.length > 0);
}

function hasBlockingCorpAction(actions: CorporateActionResult): boolean {
  if (actions.splits.length > 0) return true;
  // SC = special cash dividend in Polygon's dividend_type taxonomy. Ordinary
  // recurring dividends (CD) do not block; special dividends are large and
  // disrupt the entry-day price baseline, so they trigger SKIP.
  return actions.dividends.some((d) => d.dividendType === 'SC');
}

export async function evaluatePreFlags(input: EvaluatePreFlagsInput): Promise<PreFlagResult> {
  const { candidate, persistedCandidate, news, corporateActions, offering } = input;

  const combinedText = combineNewsText(news);
  const offeringKeywordHit = firstAffirmativeMatch(combinedText, OFFERING_TERMS);
  const dividendMatch = matchKeywords(combinedText, DIVIDEND_SUSPENSION_TERMS);
  const dividendSuspended = dividendMatch.matched;

  // EDGAR is the higher-confidence source: an actual 424B/FWP filing in the
  // lookback is far more reliable than a news headline. If EDGAR fired, mark
  // the source as 'edgar' even if a keyword also fired. If EDGAR is disabled
  // or returned no signal, fall back to the keyword path.
  let hasRecentOffering = false;
  let offeringSource: 'none' | 'keyword' | 'edgar' = 'none';
  if (offering?.hasRecentFiling) {
    hasRecentOffering = true;
    offeringSource = 'edgar';
  } else if (offeringKeywordHit) {
    hasRecentOffering = true;
    offeringSource = 'keyword';
  }

  const earningsClient = getEarningsCalendarClient();
  const earnings = await earningsClient.checkEarningsWindow({
    ticker: candidate.ticker,
    fromDate: candidate.date,
    toDate: candidate.date,
    news
  });

  const liquidityOk =
    candidate.price >= env.minPrice &&
    candidate.marketCap >= env.minMarketCap &&
    candidate.avgDollarVolume20d >= env.minAvgDollarVolume;

  const corpActionInWindow = hasBlockingCorpAction(corporateActions);
  const washSaleLockout = await hasWashSaleLockout(persistedCandidate.ticker, persistedCandidate.screen_date);

  const reasons: string[] = [];
  if (offeringSource === 'edgar') {
    reasons.push(`recent_offering_edgar:${offering?.formType ?? 'unknown'}@${offering?.filingDate ?? 'unknown'}`);
  } else if (offeringSource === 'keyword') {
    reasons.push(`recent_offering_keyword:${offeringKeywordHit}`);
  }
  if (dividendSuspended) reasons.push('dividend_suspension_keyword');
  if (earnings.hasEarningsWithin) reasons.push(`earnings_blackout:${earnings.source}`);
  if (corpActionInWindow) reasons.push('corp_action_in_lookback');
  if (!liquidityOk) reasons.push('liquidity_not_ok');
  if (washSaleLockout) reasons.push('wash_sale_lockout');

  // Skip-first ordering. Liquidity, wash-sale lockout, and corporate-action
  // overlap all bypass any further qualitative analysis. BLACKOUT is reserved
  // for earnings; AVOID is the catch-all for keyword/EDGAR-driven exclusions.
  let autoDisposition: AutoDisposition = 'OK_FOR_AI';
  if (!liquidityOk || washSaleLockout || corpActionInWindow) autoDisposition = 'SKIP';
  else if (earnings.hasEarningsWithin) autoDisposition = 'BLACKOUT';
  else if (hasRecentOffering || dividendSuspended) autoDisposition = 'AVOID';

  return {
    has_recent_offering: hasRecentOffering,
    earnings_within_5d: earnings.hasEarningsWithin,
    dividend_suspended: dividendSuspended,
    liquidity_ok: liquidityOk,
    wash_sale_lockout: washSaleLockout,
    corp_action_in_window: corpActionInWindow,
    earnings_source: earnings.source,
    offering_source: offeringSource,
    auto_disposition: autoDisposition,
    reasons
  };
}
