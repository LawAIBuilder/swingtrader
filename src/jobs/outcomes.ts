import { getMarketDataClient } from '@/lib/market/provider';
import { computeStopAndTarget } from '@/lib/risk';
import { simulateTradeDay } from '@/lib/simulator';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { todayInNewYork } from '@/lib/utils/dates';
import { round } from '@/lib/utils/numbers';
import { withRunLog } from '@/lib/run-log';
import type { DailyBar, FinalizedPaperTrade, PaperTradeRow } from '@/types/app';
import type { MarketDataClient } from '@/lib/market/client';

export interface OutcomeJobResult {
  runDate: string;
  pendingTradesSeen: number;
  pendingPromoted: number;
  pendingSkippedNoOpen: number;
  openTradesSeen: number;
  progressed: number;
  closed: number;
  skippedNoBar: number;
  corpActions: number;
  errors: Array<{ ticker: string; tradeId: number; message: string }>;
}

async function getExistingProgressionCount(tradeId: number): Promise<number> {
  const supabase = getSupabaseAdmin();
  const { count, error } = await supabase
    .from('trade_progression')
    .select('*', { count: 'exact', head: true })
    .eq('paper_trade_id', tradeId);
  if (error) throw error;
  return count ?? 0;
}

async function hasProgressForDate(tradeId: number, date: string): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('trade_progression')
    .select('paper_trade_id')
    .eq('paper_trade_id', tradeId)
    .eq('date', date)
    .limit(1);
  if (error) throw error;
  return Boolean(data && data.length > 0);
}

// Promote a pending_entry trade to status='open' using the first available daily bar
// at or after the trade's provisional entry_date. Returns the now-finalized trade and
// the bar that should be evaluated as day 1, or null if no bar is available yet
// (data not settled, ticker halted, etc.).
async function promotePendingTrade(
  trade: PaperTradeRow,
  runDate: string,
  marketClient: MarketDataClient
): Promise<{ trade: FinalizedPaperTrade; firstBar: DailyBar } | null> {
  if (runDate < trade.entry_date) return null;
  const bars = await marketClient.getTickerDailyBars(trade.ticker, trade.entry_date, runDate);
  const sorted = [...bars].sort((a, b) => a.date.localeCompare(b.date));
  const firstBar = sorted.find((b) => b.date >= trade.entry_date) ?? null;
  if (!firstBar) return null;

  const risk = computeStopAndTarget(firstBar.open, trade.atr14, trade.signal_day_low);
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from('paper_trades')
    .update({
      entry_date: firstBar.date,
      entry_price: round(firstBar.open, 4),
      stop_price: risk.stopPrice,
      target_price: risk.targetPrice,
      status: 'open'
    })
    .eq('id', trade.id);
  if (error) throw error;

  const finalized: FinalizedPaperTrade = {
    ...trade,
    entry_date: firstBar.date,
    entry_price: round(firstBar.open, 4),
    stop_price: risk.stopPrice,
    target_price: risk.targetPrice,
    status: 'open'
  };
  return { trade: finalized, firstBar };
}

interface ApplyDayResult {
  closed: boolean;
  ambiguous: boolean;
}

async function applyDayBar(trade: FinalizedPaperTrade, bar: DailyBar): Promise<ApplyDayResult> {
  const supabase = getSupabaseAdmin();
  const existingCount = await getExistingProgressionCount(trade.id);
  const dayNumber = existingCount + 1;
  const sim = simulateTradeDay(trade, bar, dayNumber);

  const { error: insertError } = await supabase.from('trade_progression').insert({
    paper_trade_id: trade.id,
    day_number: dayNumber,
    date: bar.date,
    open_price: round(bar.open, 4),
    high_price: round(bar.high, 4),
    low_price: round(bar.low, 4),
    close_price: round(bar.close, 4),
    touched_stop: sim.touchedStop,
    touched_target: sim.touchedTarget,
    is_ambiguous: sim.isAmbiguous,
    pnl_pct_gross: sim.pnlPctGross,
    pnl_pct_net: sim.pnlPctNet
  });
  if (insertError) throw insertError;

  if (sim.exitNow && sim.exitPrice != null) {
    const { error: updateError } = await supabase
      .from('paper_trades')
      .update({
        status: sim.status,
        exit_date: bar.date,
        exit_price: round(sim.exitPrice, 4),
        exit_reason: sim.exitReason,
        had_ambiguous_day: trade.had_ambiguous_day || sim.isAmbiguous,
        pnl_pct_gross: sim.pnlPctGross,
        pnl_pct_net: sim.pnlPctNet
      })
      .eq('id', trade.id);
    if (updateError) throw updateError;
    return { closed: true, ambiguous: sim.isAmbiguous };
  }

  if (sim.isAmbiguous) {
    const { error: updateError } = await supabase
      .from('paper_trades')
      .update({ had_ambiguous_day: true })
      .eq('id', trade.id);
    if (updateError) throw updateError;
  }

  return { closed: false, ambiguous: sim.isAmbiguous };
}

export interface RunOutcomeTrackerJobOptions {
  runDate?: string;
  force?: boolean;
}

export async function runOutcomeTrackerJob(options: RunOutcomeTrackerJobOptions = {}): Promise<OutcomeJobResult> {
  const runDate = options.runDate ?? todayInNewYork();
  const force = options.force ?? false;
  return withRunLog('outcome_tracker', { runDate, force }, async () => {
    const supabase = getSupabaseAdmin();
    const marketClient = getMarketDataClient();
    const { data, error } = await supabase
      .from('paper_trades')
      .select('*')
      .in('status', ['pending_entry', 'open']);
    if (error) throw error;

    const trades = (data ?? []) as unknown as PaperTradeRow[];
    const pending = trades.filter((t) => t.status === 'pending_entry');
    const open = trades.filter((t) => t.status === 'open');

    const errors: OutcomeJobResult['errors'] = [];
    let pendingPromoted = 0;
    let pendingSkippedNoOpen = 0;
    let progressed = 0;
    let closed = 0;
    let skippedNoBar = 0;
    let corpActions = 0;

    // Step 1: promote pending_entry trades whose entry_date has been reached. The
    // first available bar at or after entry_date sets entry_price, stop, and target.
    // The same bar is then evaluated as day 1, so a trade that gaps through its stop
    // on entry day is captured immediately.
    for (const trade of pending) {
      try {
        if (runDate < trade.entry_date) continue;
        const promotion = await promotePendingTrade(trade, runDate, marketClient);
        if (!promotion) {
          pendingSkippedNoOpen += 1;
          continue;
        }
        pendingPromoted += 1;

        const result = await applyDayBar(promotion.trade, promotion.firstBar);
        progressed += 1;
        if (result.closed) closed += 1;
      } catch (err) {
        errors.push({ ticker: trade.ticker, tradeId: trade.id, message: err instanceof Error ? err.message : String(err) });
      }
    }

    // Step 2: progress already-open trades for runDate.
    for (const trade of open) {
      try {
        if (runDate <= trade.entry_date) continue;
        if (await hasProgressForDate(trade.id, runDate)) continue;

        const actions = await marketClient
          .getCorporateActions(trade.ticker, trade.entry_date, runDate)
          .catch(() => ({ splits: [], dividends: [] }));
        if (actions.splits.length > 0) {
          const { error: updateError } = await supabase
            .from('paper_trades')
            .update({ status: 'corp_action', exit_date: runDate, exit_reason: 'corp_action', pnl_pct_gross: null, pnl_pct_net: null })
            .eq('id', trade.id);
          if (updateError) throw updateError;
          corpActions += 1;
          continue;
        }

        const bars = await marketClient.getTickerDailyBars(trade.ticker, runDate, runDate);
        const bar = bars.find((b) => b.date === runDate) ?? bars[0];
        if (!bar) {
          skippedNoBar += 1;
          continue;
        }

        // After Step 1 only newly promoted rows have status='open' with all price
        // fields set. The DB-level CHECK guarantees these are non-null whenever
        // status != 'pending_entry', so this cast is safe.
        const finalized = trade as unknown as FinalizedPaperTrade;
        const result = await applyDayBar(finalized, bar);
        progressed += 1;
        if (result.closed) closed += 1;
      } catch (err) {
        errors.push({ ticker: trade.ticker, tradeId: trade.id, message: err instanceof Error ? err.message : String(err) });
      }
    }

    return {
      runDate,
      pendingTradesSeen: pending.length,
      pendingPromoted,
      pendingSkippedNoOpen,
      openTradesSeen: open.length,
      progressed,
      closed,
      skippedNoBar,
      corpActions,
      errors
    };
  });
}
