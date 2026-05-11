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
  NEXT_PUBLIC_SUPABASE_URL: z.string().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional(),

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
  RUN_LOCK_TTL_MS: z.string().optional()
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

  supabaseUrl: raw.SUPABASE_URL ?? raw.NEXT_PUBLIC_SUPABASE_URL,
  supabaseServiceRoleKey: raw.SUPABASE_SERVICE_ROLE_KEY,
  nextPublicSupabaseUrl: raw.NEXT_PUBLIC_SUPABASE_URL,
  nextPublicSupabaseAnonKey: raw.NEXT_PUBLIC_SUPABASE_ANON_KEY,

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
  runLockTtlMs: parseNum(raw.RUN_LOCK_TTL_MS, 600_000)
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
