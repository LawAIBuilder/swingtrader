import { env } from '@/lib/env';
import { analyzeWithClaude, passForBudgetExhausted, syntheticAnalysisForDisposition } from '@/lib/ai/analyzer';
import { logWarn } from '@/lib/log';
import { seedBaselinesForCandidate } from '@/lib/baselines';
import { buildCatalystEvidence } from '@/lib/catalysts/evidence';
import { checkRecentOfferingFiling } from '@/lib/edgar/client';
import { getMarketDataClient } from '@/lib/market/provider';
import { evaluatePreFlags } from '@/lib/preflags';
import { computeSlippage, computeStopAndTarget } from '@/lib/risk';
import { MarketDataNotSettledError, runScreener, type ScreenerDataDiagnostics } from '@/lib/screener/run';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { addDays, nextBusinessDay } from '@/lib/utils/dates';
import { round } from '@/lib/utils/numbers';
import { withRunLog } from '@/lib/run-log';
import type { CandidateRow, CorporateActionResult, EntryMode, ScreenedCandidate } from '@/types/app';
import type { OfferingCheckResult } from '@/lib/edgar/client';
import type { MarketDataClient } from '@/lib/market/client';

export interface ScreenerJobResult {
  runDate: string;
  dataDate: string | null;
  candidatesFound: number;
  insertedOrUpdated: number;
  paperTradesCreated: number;
  baselinesSeeded: number;
  skipped: number;
  aiCalls: number;
  // True iff the AI_DAILY_BUDGET_USD cap was hit during this run and at least
  // one candidate was forced into the synthetic-fallback path. Surfaced in
  // run_logs.details so the dashboard can show "AI budget exhausted" without
  // requiring a separate query.
  aiBudgetExhausted: boolean;
  // Cumulative cost (in USD) of AI calls in this run. Useful for the operator
  // even when the cap is disabled: it answers "what would today have cost".
  aiCostUsdThisRun: number;
  notSettled?: { dataDate: string };
  // Always populated. The dashboard reads this to show provider name, base URL,
  // freshness mode, and the first few vendor errors. On not-settled runs this
  // is the only useful diagnostic the operator gets.
  diagnostics: ScreenerDataDiagnostics;
  errors: Array<{ ticker: string; message: string }>;
}

async function upsertCandidate(candidate: ScreenedCandidate): Promise<CandidateRow> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('candidates')
    .upsert(
      {
        ticker: candidate.ticker,
        screen_date: candidate.date,
        screen_source: candidate.screenSource,
        pct_change: round(candidate.pctChange, 4),
        volume: candidate.latestBar.volume,
        rel_volume: round(candidate.relVolume, 4),
        market_cap: Math.round(candidate.marketCap),
        price: round(candidate.price, 4),
        prev_close: round(candidate.previousClose, 4),
        sector: candidate.sector
      },
      { onConflict: 'ticker,screen_date,screen_source' }
    )
    .select('*')
    .single();

  if (error) throw error;
  return data as unknown as CandidateRow;
}

async function upsertCatalysts(candidateId: number, evidence: unknown, evidenceTokens: number | null): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from('catalysts').upsert(
    {
      candidate_id: candidateId,
      evidence_json: evidence,
      evidence_tokens: evidenceTokens
    },
    { onConflict: 'candidate_id' }
  );
  if (error) throw error;
}

async function upsertPreFlags(candidateId: number, flags: Awaited<ReturnType<typeof evaluatePreFlags>>): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from('pre_flags').upsert(
    {
      candidate_id: candidateId,
      has_recent_offering: flags.has_recent_offering,
      earnings_within_5d: flags.earnings_within_5d,
      dividend_suspended: flags.dividend_suspended,
      liquidity_ok: flags.liquidity_ok,
      wash_sale_lockout: flags.wash_sale_lockout,
      corp_action_in_window: flags.corp_action_in_window,
      earnings_source: flags.earnings_source,
      offering_source: flags.offering_source,
      reasons: flags.reasons,
      auto_disposition: flags.auto_disposition
    },
    { onConflict: 'candidate_id' }
  );
  if (error) throw error;
}

// Per-candidate corp-action probe. Looks at the configured window around the
// signal date for splits and special dividends. Tolerates vendor failures by
// returning an empty result so a transient outage cannot retroactively trip
// the SKIP path.
async function fetchCandidateCorporateActions(candidate: ScreenedCandidate, marketClient: MarketDataClient): Promise<CorporateActionResult> {
  const fromDate = addDays(candidate.date, -env.corpActionLookbackDays);
  const toDate = addDays(candidate.date, env.corpActionLookaheadDays);
  return marketClient
    .getCorporateActions(candidate.ticker, fromDate, toDate)
    .catch(() => ({ splits: [], dividends: [] }));
}

// Per-candidate EDGAR offering probe. Returns null when EDGAR is disabled in
// env so callers can distinguish "no signal" from "we did not check".
async function fetchOfferingFiling(candidate: ScreenedCandidate): Promise<OfferingCheckResult | null> {
  if (!env.edgarEnabled) return null;
  const fromDate = addDays(candidate.date, -env.offeringLookbackDays);
  return checkRecentOfferingFiling({
    ticker: candidate.ticker,
    fromDate,
    toDate: candidate.date
  });
}

async function insertAnalysis(candidateId: number, result: Awaited<ReturnType<typeof analyzeWithClaude>>) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('analyses')
    .insert({
      candidate_id: candidateId,
      prompt_version: env.promptVersion,
      model_name: result.modelName,
      ai_tier: result.output.tier,
      thesis: result.output.thesis,
      selloff_type: result.output.selloff_type,
      day_of_drop: result.output.day_of_drop,
      risk_flags: result.output.risk_flags,
      raw_response: result.rawResponse,
      schema_valid: result.schemaValid,
      retry_count: result.retryCount,
      tokens_used: result.tokensUsed,
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      estimated_cost_usd: result.estimatedCostUsd
    })
    .select('id')
    .single();

  if (error) throw error;
  return data as unknown as { id: number };
}

async function createPaperTrade(candidate: ScreenedCandidate, candidateRow: CandidateRow, analysisId: number | null, effectiveTier: string, entryMode: EntryMode): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const slippage = computeSlippage(candidate);

  const { data: existing, error: existingError } = await supabase
    .from('paper_trades')
    .select('id')
    .eq('candidate_id', candidateRow.id)
    .limit(1);
  if (existingError) throw existingError;
  if (existing && existing.length > 0) return false;

  const baseRow = {
    candidate_id: candidateRow.id,
    analysis_id: analysisId,
    effective_tier: effectiveTier,
    ticker: candidate.ticker,
    screen_source: candidate.screenSource,
    prompt_version: env.promptVersion,
    entry_mode: entryMode,
    signal_date: candidate.date,
    atr14: round(candidate.atr14, 4),
    signal_day_low: round(candidate.signalDayLow, 4),
    modeled_slippage_bps: slippage.modeledSlippageBps,
    liquidity_bucket: slippage.liquidityBucket
  };

  if (entryMode === 'signal_close') {
    // Diagnostic-only mode: enter at the same close that triggered the signal.
    // Not executable in practice; kept as a comparison series.
    const risk = computeStopAndTarget(candidate.price, candidate.atr14, candidate.signalDayLow);
    const { error } = await supabase.from('paper_trades').insert({
      ...baseRow,
      entry_date: candidate.date,
      entry_price: round(candidate.price, 4),
      stop_price: risk.stopPrice,
      target_price: risk.targetPrice,
      status: 'open'
    });
    if (error) throw error;
    return true;
  }

  // Default next_day_open: insert as pending_entry. The outcome tracker fills entry
  // price (using the open of the first available trading day after signal_date) and
  // promotes the row to status='open' when that bar settles.
  const provisionalEntryDate = nextBusinessDay(candidate.date);
  const { error } = await supabase.from('paper_trades').insert({
    ...baseRow,
    entry_date: provisionalEntryDate,
    entry_price: null,
    stop_price: null,
    target_price: null,
    status: 'pending_entry'
  });
  if (error) throw error;
  return true;
}

export interface RunScreenerJobOptions {
  runDate?: string;
  force?: boolean;
}

export async function runScreenerJob(options: RunScreenerJobOptions = {}): Promise<ScreenerJobResult> {
  const { runDate, force } = options;
  return withRunLog('screener', { runDate, force }, async () => {
    const marketClient = getMarketDataClient();
    let result;
    try {
      // The freshness env controls whether the screener tolerates stale dates.
      // Production must keep same_day_required so a misconfigured Polygon plan
      // cannot silently produce trades from yesterday's bars.
      const requireSettled = env.marketDataFreshnessMode === 'same_day_required';
      result = await runScreener(runDate, { requireSettled });
    } catch (err) {
      // Fail loudly but cleanly: cron fired before market data settled, or on a
      // holiday. Report a skipped run rather than entering trades on stale bars.
      if (err instanceof MarketDataNotSettledError) {
        return {
          runDate: err.runDate,
          dataDate: null,
          candidatesFound: 0,
          insertedOrUpdated: 0,
          paperTradesCreated: 0,
          baselinesSeeded: 0,
          skipped: 0,
          aiCalls: 0,
          aiBudgetExhausted: false,
          aiCostUsdThisRun: 0,
          notSettled: { dataDate: err.dataDate },
          diagnostics: err.diagnostics,
          errors: []
        };
      }
      throw err;
    }
    const errors: ScreenerJobResult['errors'] = [];
    let insertedOrUpdated = 0;
    let paperTradesCreated = 0;
    let baselinesSeeded = 0;
    let skipped = 0;
    let aiCalls = 0;
    let aiCostUsdThisRun = 0;
    let aiBudgetExhausted = false;
    const aiBudgetCap = env.aiDailyBudgetUsd;

    for (const candidate of result.candidates) {
      try {
        const candidateRow = await upsertCandidate(candidate);
        insertedOrUpdated += 1;

        const evidence = await buildCatalystEvidence(candidate, marketClient);
        await upsertCatalysts(candidateRow.id, evidence, JSON.stringify(evidence).length);

        // PR 3: corp-action and EDGAR signals are gathered alongside the news
        // packet so evaluatePreFlags stays pure (no network in the pre-flag
        // logic itself). EDGAR failures degrade to "no signal" so a vendor
        // outage cannot fabricate an AVOID.
        const [corporateActions, offering] = await Promise.all([
          fetchCandidateCorporateActions(candidate, marketClient),
          fetchOfferingFiling(candidate)
        ]);

        const flags = await evaluatePreFlags({
          candidate,
          persistedCandidate: candidateRow,
          news: evidence.news,
          corporateActions,
          offering
        });
        await upsertPreFlags(candidateRow.id, flags);

        // Seed baseline trades for buy_all and rules_only before the AI gate.
        // The AI tier never affects baselines; that's the whole point of the
        // counterfactual.
        try {
          const seeded = await seedBaselinesForCandidate({ candidate, candidateRow, preFlags: flags });
          baselinesSeeded += seeded.filter((s) => s.inserted).length;
        } catch (err) {
          errors.push({ ticker: candidate.ticker, message: `baseline_seed: ${err instanceof Error ? err.message : String(err)}` });
        }

        if (flags.auto_disposition === 'SKIP') {
          skipped += 1;
          continue;
        }

        // Budget short-circuit: once cumulative AI spend in this run exceeds
        // AI_DAILY_BUDGET_USD, every remaining OK_FOR_AI candidate switches to
        // the synthetic analyzer (which costs nothing). The first time we
        // do this we log a single warn line so the operator notices on the
        // very next dashboard refresh; subsequent skips stay quiet.
        const wouldCallAI = flags.auto_disposition === 'OK_FOR_AI';
        const overBudget = aiBudgetCap > 0 && aiCostUsdThisRun >= aiBudgetCap;
        const useFallbackForBudget = wouldCallAI && overBudget;
        if (useFallbackForBudget && !aiBudgetExhausted) {
          aiBudgetExhausted = true;
          logWarn('ai_budget_exhausted', {
            runDate: result.runDate,
            cap: aiBudgetCap,
            spent: aiCostUsdThisRun,
            remainingCandidates: result.candidates.length - result.candidates.indexOf(candidate)
          });
        }

        let analysisResult: Awaited<ReturnType<typeof analyzeWithClaude>>;
        if (useFallbackForBudget) {
          analysisResult = passForBudgetExhausted(flags.reasons);
        } else if (wouldCallAI) {
          analysisResult = await analyzeWithClaude(evidence);
        } else {
          // Pre-flag exclusion path: disposition is 'AVOID' or 'BLACKOUT'.
          analysisResult = syntheticAnalysisForDisposition(
            flags.auto_disposition as 'AVOID' | 'BLACKOUT',
            flags.reasons
          );
        }

        if (wouldCallAI && !useFallbackForBudget && analysisResult.modelName !== 'mock-ai') {
          aiCalls += 1;
          aiCostUsdThisRun += analysisResult.estimatedCostUsd ?? 0;
        }
        const analysis = await insertAnalysis(candidateRow.id, analysisResult);
        const effectiveTier = wouldCallAI && !useFallbackForBudget
          ? analysisResult.output.tier
          : useFallbackForBudget
            ? 'PASS'
            : flags.auto_disposition;
        const created = await createPaperTrade(candidate, candidateRow, analysis.id, effectiveTier, env.entryMode);
        if (created) paperTradesCreated += 1;
      } catch (err) {
        errors.push({ ticker: candidate.ticker, message: err instanceof Error ? err.message : String(err) });
      }
    }

    return {
      runDate: result.runDate,
      dataDate: result.dataDate,
      candidatesFound: result.candidates.length,
      insertedOrUpdated,
      paperTradesCreated,
      baselinesSeeded,
      skipped,
      aiCalls,
      aiBudgetExhausted,
      aiCostUsdThisRun,
      diagnostics: result.diagnostics,
      errors
    };
  });
}
