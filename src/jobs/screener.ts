import { env } from '@/lib/env';
import { analyzeWithClaude, syntheticAnalysisForDisposition } from '@/lib/ai/analyzer';
import { buildCatalystEvidence } from '@/lib/catalysts/evidence';
import { getMarketDataClient } from '@/lib/market/provider';
import { evaluatePreFlags } from '@/lib/preflags';
import { computeSlippage, computeStopAndTarget } from '@/lib/risk';
import { MarketDataNotSettledError, runScreener } from '@/lib/screener/run';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { nextBusinessDay } from '@/lib/utils/dates';
import { round } from '@/lib/utils/numbers';
import { withRunLog } from '@/lib/run-log';
import type { CandidateRow, EntryMode, ScreenedCandidate } from '@/types/app';

export interface ScreenerJobResult {
  runDate: string;
  dataDate: string | null;
  candidatesFound: number;
  insertedOrUpdated: number;
  paperTradesCreated: number;
  skipped: number;
  aiCalls: number;
  notSettled?: { dataDate: string };
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
      auto_disposition: flags.auto_disposition
    },
    { onConflict: 'candidate_id' }
  );
  if (error) throw error;
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
      tokens_used: result.tokensUsed
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

export async function runScreenerJob(runDate?: string): Promise<ScreenerJobResult> {
  return withRunLog('screener', runDate, async () => {
    const marketClient = getMarketDataClient();
    let result;
    try {
      result = await runScreener(runDate);
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
          skipped: 0,
          aiCalls: 0,
          notSettled: { dataDate: err.dataDate },
          errors: []
        };
      }
      throw err;
    }
    const errors: ScreenerJobResult['errors'] = [];
    let insertedOrUpdated = 0;
    let paperTradesCreated = 0;
    let skipped = 0;
    let aiCalls = 0;

    for (const candidate of result.candidates) {
      try {
        const candidateRow = await upsertCandidate(candidate);
        insertedOrUpdated += 1;

        const evidence = await buildCatalystEvidence(candidate, marketClient);
        await upsertCatalysts(candidateRow.id, evidence, JSON.stringify(evidence).length);

        const flags = await evaluatePreFlags(candidate, candidateRow, evidence.news);
        await upsertPreFlags(candidateRow.id, flags);

        if (flags.auto_disposition === 'SKIP') {
          skipped += 1;
          continue;
        }

        const analysisResult = flags.auto_disposition === 'OK_FOR_AI'
          ? await analyzeWithClaude(evidence)
          : syntheticAnalysisForDisposition(flags.auto_disposition, flags.reasons);

        if (flags.auto_disposition === 'OK_FOR_AI' && analysisResult.modelName !== 'mock-ai') aiCalls += 1;
        const analysis = await insertAnalysis(candidateRow.id, analysisResult);
        const effectiveTier = flags.auto_disposition === 'OK_FOR_AI' ? analysisResult.output.tier : flags.auto_disposition;
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
      skipped,
      aiCalls,
      errors
    };
  });
}
