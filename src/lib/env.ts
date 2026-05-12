import { z } from 'zod';
import type { EntryMode } from '@/types/app';

function parseBool(value: string | undefined, fallback = false): boolean {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(value.toLowerCase());
}

function parseNum(value: string | undefined, fallback: number): number {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseEntryMode(value: string | undefined): EntryMode {
  if (value === 'signal_close') return 'signal_close';
  return 'next_day_open';
}

const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.string().optional(),
  APP_BASE_URL: z.string().optional(),
  ENABLE_CRON: z.string().optional(),
  ENABLE_WEB: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  TZ: z.string().optional(),

  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_SECRET_KEY: z.string().optional(),
  NEXT_PUBLIC_SUPABASE_URL: z.string().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().optional(),
  PROMPT_VERSION: z.string().optional(),
  USE_MOCK_AI: z.string().optional(),

  POLYGON_API_KEY: z.string().optional(),
  POLYGON_BASE_URL: z.string().optional(),
  MARKET_DATA_PROVIDER: z.string().optional(),
  MOCK_MARKET_DATA: z.string().optional(),
  MAX_CANDIDATES_PER_SCREEN: z.string().optional(),
  DETAILS_CONCURRENCY: z.string().optional(),

  ALPACA_API_KEY_ID: z.string().optional(),
  ALPACA_API_SECRET_KEY: z.string().optional(),
  ALPACA_DATA_BASE_URL: z.string().optional(),

  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  EMAIL_TO: z.string().optional(),

  MIN_MARKET_CAP: z.string().optional(),
  MIN_PRICE: z.string().optional(),
  MAX_PRICE: z.string().optional(),
  MIN_AVG_DOLLAR_VOLUME: z.string().optional(),
  SCREEN_A_DROP_PCT: z.string().optional(),
  SCREEN_A_REL_VOLUME: z.string().optional(),
  SCREEN_B_5D_DROP_PCT: z.string().optional(),
  SCREEN_B_DRAWDOWN_20D_PCT: z.string().optional(),
  TIME_STOP_DAYS: z.string().optional(),
  ENTRY_MODE: z.string().optional(),

  FETCH_TIMEOUT_MS: z.string().optional(),
  ANTHROPIC_TIMEOUT_MS: z.string().optional(),
  GROUPED_BARS_CONCURRENCY: z.string().optional(),
  ANTHROPIC_CONCURRENCY: z.string().optional(),
  RUN_LOCK_TTL_MS: z.string().optional(),

  EARNINGS_CALENDAR_PROVIDER: z.string().optional(),
  FINNHUB_API_KEY: z.string().optional(),
  FINNHUB_BASE_URL: z.string().optional(),
  EDGAR_ENABLED: z.string().optional(),
  EDGAR_USER_AGENT: z.string().optional(),
  EDGAR_BASE_URL: z.string().optional(),
  EDGAR_TICKERS_URL: z.string().optional(),
  CORP_ACTION_LOOKBACK_DAYS: z.string().optional(),
  CORP_ACTION_LOOKAHEAD_DAYS: z.string().optional(),
  OFFERING_LOOKBACK_DAYS: z.string().optional()
}).passthrough();

const raw = EnvSchema.parse(process.env);

export const env = {
  nodeEnv: raw.NODE_ENV,
  port: parseNum(raw.PORT, 3000),
  appBaseUrl: raw.APP_BASE_URL ?? 'http://localhost:3000',
  enableCron: parseBool(raw.ENABLE_CRON, false),
  enableWeb: parseBool(raw.ENABLE_WEB, true),
  cronSecret: raw.CRON_SECRET,
  timezone: raw.TZ ?? 'America/New_York',

  // The official Supabase Vercel Marketplace integration writes
  // SUPABASE_SECRET_KEY / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY under the new
  // naming scheme. We accept either name so the same build works with both
  // manually-managed env vars and integration-managed ones.
  supabaseUrl: raw.SUPABASE_URL ?? raw.NEXT_PUBLIC_SUPABASE_URL,
  supabaseServiceRoleKey: raw.SUPABASE_SERVICE_ROLE_KEY ?? raw.SUPABASE_SECRET_KEY,
  nextPublicSupabaseUrl: raw.NEXT_PUBLIC_SUPABASE_URL,
  nextPublicSupabaseAnonKey:
    raw.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? raw.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,

  anthropicApiKey: raw.ANTHROPIC_API_KEY,
  anthropicModel: raw.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
  promptVersion: raw.PROMPT_VERSION ?? 'v1.0',
  useMockAi: parseBool(raw.USE_MOCK_AI, false),

  polygonApiKey: raw.POLYGON_API_KEY,
  polygonBaseUrl: raw.POLYGON_BASE_URL ?? 'https://api.polygon.io',
  marketDataProvider: raw.MARKET_DATA_PROVIDER ?? 'polygon',
  mockMarketData: parseBool(raw.MOCK_MARKET_DATA, false),
  maxCandidatesPerScreen: parseNum(raw.MAX_CANDIDATES_PER_SCREEN, 20),
  detailsConcurrency: parseNum(raw.DETAILS_CONCURRENCY, 4),

  alpacaApiKeyId: raw.ALPACA_API_KEY_ID,
  alpacaApiSecretKey: raw.ALPACA_API_SECRET_KEY,
  alpacaDataBaseUrl: raw.ALPACA_DATA_BASE_URL ?? 'https://data.alpaca.markets',

  resendApiKey: raw.RESEND_API_KEY,
  emailFrom: raw.EMAIL_FROM,
  emailTo: raw.EMAIL_TO,

  minMarketCap: parseNum(raw.MIN_MARKET_CAP, 2_000_000_000),
  minPrice: parseNum(raw.MIN_PRICE, 10),
  maxPrice: parseNum(raw.MAX_PRICE, 300),
  minAvgDollarVolume: parseNum(raw.MIN_AVG_DOLLAR_VOLUME, 20_000_000),
  screenADropPct: parseNum(raw.SCREEN_A_DROP_PCT, -7),
  screenARelVolume: parseNum(raw.SCREEN_A_REL_VOLUME, 1.5),
  screenB5dDropPct: parseNum(raw.SCREEN_B_5D_DROP_PCT, -12),
  screenBDrawdown20dPct: parseNum(raw.SCREEN_B_DRAWDOWN_20D_PCT, -15),
  timeStopDays: parseNum(raw.TIME_STOP_DAYS, 5),
  entryMode: parseEntryMode(raw.ENTRY_MODE),

  // PR 2: bounded latencies and concurrency for external IO.
  // Per-request HTTP timeout for Polygon and Alpaca calls.
  fetchTimeoutMs: parseNum(raw.FETCH_TIMEOUT_MS, 15_000),
  // Per-request timeout passed to the Anthropic SDK.
  anthropicTimeoutMs: parseNum(raw.ANTHROPIC_TIMEOUT_MS, 30_000),
  // Concurrency cap for the lookback grouped-bar fetch in the screener.
  groupedBarsConcurrency: parseNum(raw.GROUPED_BARS_CONCURRENCY, 4),
  // Concurrency cap for Anthropic messages.create. Wraps every analyzer call so
  // future parallel candidate processing cannot exceed this.
  anthropicConcurrency: parseNum(raw.ANTHROPIC_CONCURRENCY, 2),
  // Stale-lock TTL. A 'running' run_logs row older than this is treated as a
  // crashed prior run and is reaped before a new run acquires the lock.
  runLockTtlMs: parseNum(raw.RUN_LOCK_TTL_MS, 600_000),

  // PR 3: provider abstraction for the earnings calendar. 'keyword_fallback'
  // (default) reuses the news regex; 'finnhub' hits the Finnhub calendar API
  // when FINNHUB_API_KEY is set. Any unrecognized value still falls back to
  // keyword detection so production cannot silently behave like a real
  // calendar check happened.
  earningsCalendarProvider: raw.EARNINGS_CALENDAR_PROVIDER ?? 'keyword_fallback',
  finnhubApiKey: raw.FINNHUB_API_KEY,
  finnhubBaseUrl: raw.FINNHUB_BASE_URL ?? 'https://finnhub.io/api/v1',

  // EDGAR offering-filing parser. Enabled by default if a User-Agent is
  // configured, since SEC requires one for any traffic. Disable explicitly
  // with EDGAR_ENABLED=false in dev to skip the network calls.
  edgarEnabled: parseBool(raw.EDGAR_ENABLED, true),
  edgarUserAgent: raw.EDGAR_USER_AGENT ?? 'BounceTrader/0.1 contact@example.com',
  edgarBaseUrl: raw.EDGAR_BASE_URL ?? 'https://data.sec.gov',
  edgarTickersUrl: raw.EDGAR_TICKERS_URL ?? 'https://www.sec.gov/files/company_tickers.json',

  // Window for the screen-time corporate-action skip. Lookback covers historic
  // splits whose effect on the 20d lookback metrics may persist; lookahead
  // covers actions inside the time-stop horizon.
  corpActionLookbackDays: parseNum(raw.CORP_ACTION_LOOKBACK_DAYS, 30),
  corpActionLookaheadDays: parseNum(raw.CORP_ACTION_LOOKAHEAD_DAYS, 10),
  // How far back to search EDGAR for offering filings. 30d catches recent
  // pricings (424B*) without diluting the signal with old shelf registrations.
  offeringLookbackDays: parseNum(raw.OFFERING_LOOKBACK_DAYS, 30)
};

export function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export function hasSupabaseConfig(): boolean {
  return Boolean(env.supabaseUrl && env.supabaseServiceRoleKey);
}

export function hasPublicSupabaseConfig(): boolean {
  return Boolean(env.nextPublicSupabaseUrl && env.nextPublicSupabaseAnonKey);
}
