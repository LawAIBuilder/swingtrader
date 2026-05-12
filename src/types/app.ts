export type ScreenSource = 'screen_a' | 'screen_b';
export type AiTier = 'BUY' | 'PASS' | 'AVOID';
export type AutoDisposition = 'AVOID' | 'BLACKOUT' | 'OK_FOR_AI' | 'SKIP';
export type TradeStatus = 'pending_entry' | 'open' | 'stopped' | 'target_hit' | 'time_closed' | 'corp_action';
export type EntryMode = 'signal_close' | 'next_day_open';

export interface DailyBar {
  ticker: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap?: number | null;
  transactions?: number | null;
}

export interface TickerDetails {
  ticker: string;
  name?: string | null;
  marketCap?: number | null;
  sector?: string | null;
  primaryExchange?: string | null;
  type?: string | null;
  locale?: string | null;
  country?: string | null;
  active?: boolean | null;
  sicDescription?: string | null;
}

export interface NewsItem {
  id?: string;
  ticker?: string;
  title: string;
  description?: string | null;
  articleUrl?: string | null;
  publishedUtc: string;
  publisherName?: string | null;
  tickers?: string[];
  insights?: Array<{ ticker?: string; sentiment?: string; sentiment_reasoning?: string }>;
}

// Polygon dividend_type codes. CD = ordinary cash; SC = special cash;
// LT = long-term capital gain; ST = short-term. Treated as 'unknown' if the
// vendor omits the field.
export type DividendType = 'CD' | 'SC' | 'LT' | 'ST' | 'unknown';

export interface CorporateActionResult {
  splits: Array<{ executionDate?: string; splitFrom?: number; splitTo?: number; raw: unknown }>;
  dividends: Array<{
    exDividendDate?: string;
    cashAmount?: number;
    dividendType: DividendType;
    raw: unknown;
  }>;
}

export interface TickerMetrics {
  ticker: string;
  date: string;
  latestBar: DailyBar;
  previousClose: number;
  pctChange: number;
  pctChange5d: number;
  relVolume: number;
  avgVolume20d: number;
  avgDollarVolume20d: number;
  atr14: number;
  drawdownFrom20dHighPct: number;
  signalDayLow: number;
}

export interface ScreenedCandidate extends TickerMetrics {
  screenSource: ScreenSource;
  details: TickerDetails;
  sector: string | null;
  marketCap: number;
  price: number;
}

export interface CandidateRow {
  id: number;
  ticker: string;
  screen_date: string;
  screen_source: ScreenSource;
  pct_change: number | null;
  volume: number | null;
  rel_volume: number | null;
  market_cap: number | null;
  price: number | null;
  prev_close: number | null;
  sector: string | null;
}

export interface PaperTradeRow {
  id: number;
  candidate_id: number;
  analysis_id: number | null;
  effective_tier: string;
  ticker: string;
  screen_source: string;
  prompt_version: string | null;
  entry_mode: EntryMode;
  signal_date: string;
  entry_date: string;
  entry_price: number | null;
  atr14: number;
  signal_day_low: number;
  stop_price: number | null;
  target_price: number | null;
  modeled_slippage_bps: number;
  liquidity_bucket: string;
  status: TradeStatus;
  exit_date: string | null;
  exit_price: number | null;
  exit_reason: string | null;
  had_ambiguous_day: boolean | null;
  pnl_pct_gross: number | null;
  pnl_pct_net: number | null;
}

export interface FinalizedPaperTrade extends PaperTradeRow {
  entry_price: number;
  stop_price: number;
  target_price: number;
  status: Exclude<TradeStatus, 'pending_entry'>;
}
