import { getSupabaseAdmin } from '@/lib/supabase/admin';
import type { AutoDisposition, CandidateRow, NewsItem, ScreenedCandidate } from '@/types/app';

export interface PreFlagResult {
  has_recent_offering: boolean;
  earnings_within_5d: boolean;
  dividend_suspended: boolean;
  liquidity_ok: boolean;
  wash_sale_lockout: boolean;
  auto_disposition: AutoDisposition;
  reasons: string[];
}

const offeringTerms = [
  'secondary offering',
  'public offering',
  'share offering',
  'registered direct offering',
  'convertible notes',
  'convertible note',
  'at-the-market offering',
  'atm offering',
  'dilution',
  'prices offering'
];

const dividendSuspensionTerms = [
  'suspends dividend',
  'suspended dividend',
  'dividend suspension',
  'eliminates dividend',
  'cuts dividend to zero'
];

const earningsBlackoutTerms = [
  'reports earnings tomorrow',
  'reports quarterly results tomorrow',
  'to report earnings',
  'earnings expected',
  'earnings scheduled',
  'will report earnings'
];

function text(news: NewsItem[]): string {
  return news.map((n) => `${n.title} ${n.description ?? ''}`).join(' ').toLowerCase();
}

function containsAny(haystack: string, needles: string[]): boolean {
  return needles.some((term) => haystack.includes(term));
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

export async function evaluatePreFlags(candidate: ScreenedCandidate, persistedCandidate: CandidateRow, news: NewsItem[]): Promise<PreFlagResult> {
  const combined = text(news);
  const hasRecentOffering = containsAny(combined, offeringTerms);
  const dividendSuspended = containsAny(combined, dividendSuspensionTerms);
  const earningsWithin5d = containsAny(combined, earningsBlackoutTerms);
  const liquidityOk = candidate.price >= 10 && candidate.marketCap >= 2_000_000_000 && candidate.avgDollarVolume20d >= 20_000_000;
  const washSaleLockout = await hasWashSaleLockout(persistedCandidate.ticker, persistedCandidate.screen_date);

  const reasons: string[] = [];
  if (hasRecentOffering) reasons.push('recent_offering_keyword');
  if (dividendSuspended) reasons.push('dividend_suspension_keyword');
  if (earningsWithin5d) reasons.push('earnings_blackout_keyword');
  if (!liquidityOk) reasons.push('liquidity_not_ok');
  if (washSaleLockout) reasons.push('wash_sale_lockout');

  let autoDisposition: AutoDisposition = 'OK_FOR_AI';
  if (!liquidityOk || washSaleLockout) autoDisposition = 'SKIP';
  else if (earningsWithin5d) autoDisposition = 'BLACKOUT';
  else if (hasRecentOffering || dividendSuspended) autoDisposition = 'AVOID';

  return {
    has_recent_offering: hasRecentOffering,
    earnings_within_5d: earningsWithin5d,
    dividend_suspended: dividendSuspended,
    liquidity_ok: liquidityOk,
    wash_sale_lockout: washSaleLockout,
    auto_disposition: autoDisposition,
    reasons
  };
}
