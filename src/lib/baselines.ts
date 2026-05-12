import { env } from '@/lib/env';
import { computeSlippage } from '@/lib/risk';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { nextBusinessDay } from '@/lib/utils/dates';
import { round } from '@/lib/utils/numbers';
import type { CandidateRow, ScreenedCandidate } from '@/types/app';
import type { PreFlagResult } from '@/lib/preflags';

// PR 6 baselines. Inserted alongside paper_trades so we can compare the
// AI-gated signal against simpler counterfactuals later.
//
//   buy_all     - bought regardless of pre-flag or AI tier. Lower bound.
//   rules_only  - bought when pre-flag did not REJECT (auto_disposition is
//                 OK_FOR_AI or OK). No AI gate. Useful to isolate the AI
//                 contribution.
//
// Both use the same conservative stop/target machinery as paper_trades, so
// outcomes are apples-to-apples once entry fills are resolved by the outcome
// tracker.

export type BaselineKind = 'buy_all' | 'rules_only';

export interface SeedBaselineInput {
  candidate: ScreenedCandidate;
  candidateRow: CandidateRow;
  preFlags: PreFlagResult;
}

interface BaselineInsertResult {
  kind: BaselineKind;
  inserted: boolean;
  reason?: string;
}

async function insertBaselineRow(input: SeedBaselineInput, kind: BaselineKind): Promise<BaselineInsertResult> {
  const supabase = getSupabaseAdmin();
  const { candidate, candidateRow } = input;
  const slippage = computeSlippage(candidate);
  const provisionalEntryDate = nextBusinessDay(candidate.date);

  // Idempotent: rerunning the screener for the same date must not duplicate.
  const { data: existing, error: existingErr } = await supabase
    .from('baseline_trades')
    .select('id')
    .eq('candidate_id', candidateRow.id)
    .eq('baseline_kind', kind)
    .limit(1);
  if (existingErr) throw existingErr;
  if (existing && existing.length > 0) return { kind, inserted: false, reason: 'already_exists' };

  const { error } = await supabase.from('baseline_trades').insert({
    candidate_id: candidateRow.id,
    baseline_kind: kind,
    ticker: candidate.ticker,
    signal_date: candidate.date,
    entry_date: provisionalEntryDate,
    entry_price: null,
    atr14: round(candidate.atr14, 4),
    signal_day_low: round(candidate.signalDayLow, 4),
    stop_price: null,
    target_price: null,
    modeled_slippage_bps: slippage.modeledSlippageBps,
    liquidity_bucket: slippage.liquidityBucket,
    status: 'pending_entry'
  });
  if (error) throw error;
  return { kind, inserted: true };
}

// Decides which baseline kinds apply for a given candidate + pre-flag result
// and inserts them. SKIP candidates (corp action / wash sale / illiquid)
// don't even seed buy_all because they will fail to settle anyway.
export async function seedBaselinesForCandidate(input: SeedBaselineInput): Promise<BaselineInsertResult[]> {
  // Outcome tracker requires real bars to settle. SKIP/BLACKOUT rows are
  // intentionally excluded from baselines so they don't pollute the
  // never-settled rate. Same with entry_mode=signal_close (diagnostic only).
  if (input.preFlags.auto_disposition === 'SKIP') return [];
  if (env.entryMode === 'signal_close') return [];

  const results: BaselineInsertResult[] = [];
  results.push(await insertBaselineRow(input, 'buy_all'));
  if (input.preFlags.auto_disposition === 'OK_FOR_AI') {
    results.push(await insertBaselineRow(input, 'rules_only'));
  }
  return results;
}
