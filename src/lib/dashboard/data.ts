import { hasPublicSupabaseConfig, env } from '@/lib/env';
import { getSupabasePublic } from '@/lib/supabase/public';
import { getSupabaseAuthBT } from '@/lib/supabase/server';

// Server-side dashboard data layer. Uses the anon key against the Supabase
// views surfaced by supabase/schema.sql. Never imports the service role
// client; this module is safe to call from server components that ship to the
// edge or to a Vercel serverless function.

export interface RunLogRow {
  id: number;
  run_date: string;
  job_name: string;
  status: 'running' | 'success' | 'partial' | 'failed' | 'skipped';
  details: Record<string, unknown> | null;
  duration_ms: number | null;
  ran_at: string;
}

export interface CandidateView {
  id: number;
  ticker: string;
  screen_date: string;
  screen_source: 'screen_a' | 'screen_b';
  pct_change: number | null;
  volume: number | null;
  rel_volume: number | null;
  market_cap: number | null;
  price: number | null;
  prev_close: number | null;
  sector: string | null;
  auto_disposition: string | null;
  has_recent_offering: boolean | null;
  earnings_within_5d: boolean | null;
  ai_tier: string | null;
  thesis: string | null;
  selloff_type: string | null;
  risk_flags: string[] | null;
  effective_tier: string | null;
  entry_mode: string | null;
  trade_status: string | null;
  stop_price: number | null;
  target_price: number | null;
}

export interface OpenTradeView {
  id: number;
  ticker: string;
  effective_tier: string;
  entry_date: string;
  entry_price: number | null;
  stop_price: number | null;
  target_price: number | null;
  days_open: number | null;
  latest_pnl_net: number | null;
  status: string;
  signal_date: string;
  modeled_slippage_bps: number;
  liquidity_bucket: string;
}

export interface ClosedTradeView {
  id: number;
  ticker: string;
  effective_tier: string;
  entry_date: string;
  entry_price: number | null;
  exit_date: string | null;
  exit_price: number | null;
  exit_reason: string | null;
  pnl_pct_net: number | null;
  pnl_pct_gross: number | null;
  had_ambiguous_day: boolean | null;
  status: string;
}

export interface StatRow {
  group_key: string;
  closed_trades: number;
  win_rate: number | null;
  avg_pnl_net: number | null;
  avg_pnl_gross: number | null;
  ambiguous_rate: number | null;
}

export interface DailySummaryRow {
  id: number;
  run_date: string;
  markdown: string;
  emailed: boolean;
  email_reason: string | null;
  generated_at: string;
}

export interface DashboardErrors {
  // View name -> truncated supabase error message. Surfaced to the operator on
  // the dashboard so a transient Supabase outage is observable instead of 500.
  [view: string]: string;
}

export interface DashboardData {
  todayCandidates: CandidateView[];
  openTrades: OpenTradeView[];
  recentClosed: ClosedTradeView[];
  tierStats: StatRow[];
  screenStats: StatRow[];
  runLogs: RunLogRow[];
  errors: DashboardErrors;
}

// Resilient fetch: a single failing view should not 500 the entire dashboard.
// We collect each view's error into `errors` so the page can render the parts
// that did work and show the operator which view broke. The only path that
// returns null is "Supabase isn't configured at all"; everything else returns
// a (potentially partial) object.
export async function fetchDashboardData(): Promise<DashboardData | null> {
  if (!hasPublicSupabaseConfig()) return null;
  const supabase = getSupabasePublic();
  const [todayRun, openTrades, recentClosed, tierStats, screenStats, runLogs] = await Promise.all([
    supabase.from('v_dashboard_today_candidates').select('*').limit(200),
    supabase.from('v_dashboard_open_trades').select('*').limit(200),
    supabase.from('v_dashboard_recent_closed_trades').select('*').limit(50),
    supabase.from('v_basic_stats_by_tier').select('*').order('group_key'),
    supabase.from('v_basic_stats_by_screen').select('*').order('group_key'),
    supabase.from('v_recent_run_logs').select('*').limit(50)
  ]);

  const errors: DashboardErrors = {};
  const captured: Array<[string, { error: unknown }]> = [
    ['v_dashboard_today_candidates', todayRun],
    ['v_dashboard_open_trades', openTrades],
    ['v_dashboard_recent_closed_trades', recentClosed],
    ['v_basic_stats_by_tier', tierStats],
    ['v_basic_stats_by_screen', screenStats],
    ['v_recent_run_logs', runLogs]
  ];
  for (const [name, res] of captured) {
    if (res.error) {
      const msg = (res.error as { message?: string }).message ?? 'unknown';
      errors[name] = msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
    }
  }

  return {
    todayCandidates: (todayRun.data ?? []) as unknown as CandidateView[],
    openTrades: (openTrades.data ?? []) as unknown as OpenTradeView[],
    recentClosed: (recentClosed.data ?? []) as unknown as ClosedTradeView[],
    tierStats: (tierStats.data ?? []) as unknown as StatRow[],
    screenStats: (screenStats.data ?? []) as unknown as StatRow[],
    runLogs: (runLogs.data ?? []) as unknown as RunLogRow[],
    errors
  };
}

export interface AiCostDailyRow {
  day: string;
  model_name: string;
  prompt_version: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  schema_valid_rate: number | null;
}

export async function fetchAiCostDaily(limit = 14): Promise<AiCostDailyRow[]> {
  if (!hasPublicSupabaseConfig()) return [];
  try {
    const supabase = getSupabasePublic();
    const { data, error } = await supabase
      .from('v_ai_cost_daily')
      .select('*')
      .limit(limit);
    if (error) return [];
    return (data ?? []) as unknown as AiCostDailyRow[];
  } catch {
    return [];
  }
}

async function fetchStatView(view: string): Promise<StatRow[]> {
  if (!hasPublicSupabaseConfig()) return [];
  try {
    const supabase = getSupabasePublic();
    const { data, error } = await supabase.from(view).select('*').order('group_key');
    if (error) return [];
    return (data ?? []) as unknown as StatRow[];
  } catch {
    return [];
  }
}

export async function fetchPromptStats(): Promise<StatRow[]> {
  return fetchStatView('v_basic_stats_by_prompt');
}

export async function fetchSelloffStats(): Promise<StatRow[]> {
  return fetchStatView('v_basic_stats_by_selloff');
}

export async function fetchSectorStats(): Promise<StatRow[]> {
  return fetchStatView('v_basic_stats_by_sector');
}

export async function fetchDispositionStats(): Promise<StatRow[]> {
  return fetchStatView('v_basic_stats_by_disposition');
}

export async function fetchBaselineStats(): Promise<StatRow[]> {
  return fetchStatView('v_baseline_stats');
}

export interface DailySeriesRow {
  day: string;
  candidates?: number;
  unique_tickers?: number;
  closed?: number;
  sum_pnl_net?: number | null;
  avg_pnl_net?: number | null;
  win_rate?: number | null;
}

export async function fetchCandidatesPerDay(limit = 60): Promise<DailySeriesRow[]> {
  if (!hasPublicSupabaseConfig()) return [];
  try {
    const supabase = getSupabasePublic();
    const { data, error } = await supabase
      .from('v_candidates_per_day')
      .select('*')
      .limit(limit);
    if (error) return [];
    return (data ?? []) as unknown as DailySeriesRow[];
  } catch {
    return [];
  }
}

export interface IntradayTradeRow {
  id: number;
  ticker: string;
  entered_at: string;
  exited_at: string | null;
  entry_price: number | null;
  exit_price: number | null;
  stop_price: number | null;
  target_price: number | null;
  status: string;
  exit_reason: string | null;
  spread_bps_at_entry: number | null;
  modeled_slippage_bps: number | null;
  max_adverse_excursion_bps: number | null;
  max_favorable_excursion_bps: number | null;
  signal_source: string | null;
}

export async function fetchRecentIntradayTrades(limit = 50): Promise<IntradayTradeRow[]> {
  if (!hasPublicSupabaseConfig()) return [];
  try {
    const supabase = getSupabasePublic();
    const { data, error } = await supabase
      .from('v_recent_intraday_trades')
      .select('*')
      .limit(limit);
    if (error) return [];
    return (data ?? []) as unknown as IntradayTradeRow[];
  } catch {
    return [];
  }
}

export async function fetchPnlPerDay(limit = 60): Promise<DailySeriesRow[]> {
  if (!hasPublicSupabaseConfig()) return [];
  try {
    const supabase = getSupabasePublic();
    const { data, error } = await supabase
      .from('v_pnl_per_day')
      .select('*')
      .limit(limit);
    if (error) return [];
    return (data ?? []) as unknown as DailySeriesRow[];
  } catch {
    return [];
  }
}

// daily_summaries is RLS-restricted to the authenticated role. We use the
// cookie-aware auth client so RLS evaluates the request as the signed-in
// operator. Without this the dashboard would always see zero summaries even
// after the gate sees them.
export async function fetchRecentDailySummaries(limit = 10): Promise<DailySummaryRow[]> {
  if (!hasPublicSupabaseConfig()) return [];
  try {
    const supabase = await getSupabaseAuthBT();
    const { data, error } = await supabase
      .from('v_recent_daily_summaries')
      .select('*')
      .limit(limit);
    if (error) {
      // RLS denial (signed out) or schema-not-applied: surface zero rows
      // rather than an unhandled exception so the dashboard still renders.
      return [];
    }
    return (data ?? []) as unknown as DailySummaryRow[];
  } catch {
    return [];
  }
}

export interface SystemState {
  // Resolved provider information from env. Reflects what the next screener
  // run will actually do, not the raw env.
  marketProvider: 'mock' | 'polygon' | 'unknown';
  aiMode: 'mock' | 'anthropic';
  freshnessMode: 'same_day_required' | 'latest_available';
  promptVersion: string;
  entryMode: string;
  hasSupabaseConfig: boolean;
  // Most recent run_logs row per job. Undefined if never run.
  latestScreener?: RunLogRow;
  latestOutcome?: RunLogRow;
  latestSummary?: RunLogRow;
  // Latest data date the screener actually fetched, or null if no successful
  // screener run is recorded.
  latestDataDate: string | null;
  // Most recent run that refused to enter trades because data was stale.
  // Surfaced prominently because it's the single best signal that a paid
  // upgrade is needed.
  lastNotSettled?: { runDate: string; dataDate: string; ranAt: string };
  // Inferred when the latest screener diagnostics contain a
  // POLYGON_NOT_AUTHORIZED sample. This is the single most common production
  // misconfiguration and is called out explicitly in the UI.
  polygonNotAuthorized?: { sample: string; ranAt: string };
  // Set when the most recent screener run hit the AI_DAILY_BUDGET_USD cap and
  // routed candidates to the synthetic-fallback PASS analyzer. Surfaced as a
  // banner so an operator notices on the next dashboard refresh.
  aiBudgetExhaustedToday?: { runDate: string; spent: number; cap: number; ranAt: string };
  // Set iff CRON_SECRET is unset AND ALLOW_UNAUTHENTICATED_CRON=true on this
  // deployment. That combination is only safe for local dev; surfacing it in
  // the dashboard makes a misconfigured production deploy obvious.
  cronOpenToPublic: boolean;
}

function parseDetails(row: RunLogRow | undefined): Record<string, unknown> | null {
  if (!row) return null;
  if (!row.details) return null;
  if (typeof row.details === 'object') return row.details as Record<string, unknown>;
  return null;
}

export function deriveSystemState(runLogs: RunLogRow[]): SystemState {
  const latestByJob = new Map<string, RunLogRow>();
  for (const row of runLogs) {
    const existing = latestByJob.get(row.job_name);
    if (!existing || row.ran_at > existing.ran_at) {
      latestByJob.set(row.job_name, row);
    }
  }

  const latestScreener = latestByJob.get('screener');
  const latestOutcome = latestByJob.get('outcome_tracker');
  const latestSummary = latestByJob.get('daily_summary');

  let latestDataDate: string | null = null;
  let lastNotSettled: SystemState['lastNotSettled'] | undefined;
  let polygonNotAuthorized: SystemState['polygonNotAuthorized'] | undefined;
  let aiBudgetExhaustedToday: SystemState['aiBudgetExhaustedToday'] | undefined;

  for (const row of runLogs) {
    if (row.job_name !== 'screener') continue;
    const details = parseDetails(row);
    const result = details?.result as Record<string, unknown> | undefined;
    if (!result) continue;
    if (latestDataDate == null && typeof result.dataDate === 'string') {
      latestDataDate = result.dataDate;
    }
    if (!lastNotSettled && result.notSettled) {
      const ns = result.notSettled as Record<string, unknown>;
      lastNotSettled = {
        runDate: typeof result.runDate === 'string' ? result.runDate : row.run_date,
        dataDate: typeof ns.dataDate === 'string' ? ns.dataDate : '',
        ranAt: row.ran_at
      };
    }
    if (!polygonNotAuthorized) {
      const diagnostics = result.diagnostics as Record<string, unknown> | undefined;
      const samples = diagnostics?.errorSamples;
      if (Array.isArray(samples)) {
        const hit = samples.find((s) => typeof s === 'string' && s.includes('POLYGON_NOT_AUTHORIZED'));
        if (typeof hit === 'string') {
          polygonNotAuthorized = { sample: hit, ranAt: row.ran_at };
        }
      }
    }
    if (!aiBudgetExhaustedToday && result.aiBudgetExhausted === true) {
      aiBudgetExhaustedToday = {
        runDate: typeof result.runDate === 'string' ? result.runDate : row.run_date,
        spent: typeof result.aiCostUsdThisRun === 'number' ? result.aiCostUsdThisRun : 0,
        cap: env.aiDailyBudgetUsd,
        ranAt: row.ran_at
      };
    }
    if (latestDataDate && lastNotSettled && polygonNotAuthorized && aiBudgetExhaustedToday) break;
  }

  const aiMode: 'mock' | 'anthropic' = env.useMockAi || !env.anthropicApiKey ? 'mock' : 'anthropic';
  const marketProvider: SystemState['marketProvider'] = env.mockMarketData
    ? 'mock'
    : !env.polygonApiKey
      ? 'mock'
      : env.marketDataProvider === 'polygon'
        ? 'polygon'
        : 'unknown';

  return {
    marketProvider,
    aiMode,
    freshnessMode: env.marketDataFreshnessMode,
    promptVersion: env.promptVersion,
    entryMode: env.entryMode,
    hasSupabaseConfig: hasPublicSupabaseConfig(),
    latestScreener,
    latestOutcome,
    latestSummary,
    latestDataDate,
    lastNotSettled,
    polygonNotAuthorized,
    aiBudgetExhaustedToday,
    cronOpenToPublic: !env.cronSecret && env.allowUnauthenticatedCron
  };
}

// Helper for /trades/[id]: resolve trade + candidate + analysis + pre-flags
// + progression in one server-side call. Reads only via the anon key, so this
// is safe in a public dashboard.
export interface TradeDetail {
  trade: Record<string, unknown> | null;
  candidate: Record<string, unknown> | null;
  preFlags: Record<string, unknown> | null;
  analysis: Record<string, unknown> | null;
  progression: Array<Record<string, unknown>>;
}

export async function fetchTradeDetail(tradeId: number): Promise<TradeDetail | null> {
  if (!hasPublicSupabaseConfig()) return null;
  const supabase = getSupabasePublic();

  const { data: tradeData, error: tradeErr } = await supabase
    .from('paper_trades')
    .select('*')
    .eq('id', tradeId)
    .limit(1)
    .maybeSingle();
  if (tradeErr) throw tradeErr;
  if (!tradeData) return null;

  const trade = tradeData as Record<string, unknown>;
  const candidateId = trade.candidate_id as number | null;

  const [candidateRes, preFlagsRes, analysisRes, progressionRes] = await Promise.all([
    candidateId != null
      ? supabase.from('candidates').select('*').eq('id', candidateId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    candidateId != null
      ? supabase.from('pre_flags').select('*').eq('candidate_id', candidateId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    candidateId != null
      ? supabase.from('analyses').select('*').eq('candidate_id', candidateId).order('analyzed_at', { ascending: false }).limit(1).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    supabase
      .from('trade_progression')
      .select('*')
      .eq('paper_trade_id', tradeId)
      .order('day_number', { ascending: true })
  ]);

  // Secondary fetches are non-fatal. The trade row itself is the only required
  // piece for /trades/[id] to render; missing pre_flags / analysis / progression
  // is just empty state in the UI. A Supabase blip on one of them must not
  // bubble up as a 500 for the whole page.
  return {
    trade,
    candidate: (candidateRes.data ?? null) as Record<string, unknown> | null,
    preFlags: (preFlagsRes.data ?? null) as Record<string, unknown> | null,
    analysis: (analysisRes.data ?? null) as Record<string, unknown> | null,
    progression: ((progressionRes.data ?? []) as unknown as Array<Record<string, unknown>>) ?? []
  };
}
