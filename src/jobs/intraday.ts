import { env } from '@/lib/env';
import { evaluateOpenIntradayTrade, isQuoteStale } from '@/lib/intraday/entry';
import { getIntradayClient } from '@/lib/intraday/provider';
import { computeSpread, decideSlippage } from '@/lib/intraday/slippage';
import { withRunLog } from '@/lib/run-log';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { todayInNewYork } from '@/lib/utils/dates';
import { round } from '@/lib/utils/numbers';

export interface IntradayTickResult {
  tradesScanned: number;
  ticksRecorded: number;
  closedThisTick: number;
  rejectedWideSpread: number;
  staleQuotesSkipped: number;
  // Quote provider returned null (no quote available, market closed, vendor
  // outage). Tracked separately from staleQuotesSkipped because they imply
  // different operator actions: a few stale quotes during low-volume hours
  // are normal, but null quotes across many tickers usually mean the
  // provider is down.
  quoteUnavailable: number;
  newlyOpened: number;
  entriesEvaluated: number;
  entriesRejected: Array<{ ticker: string; reason: string }>;
  errors: Array<{ ticker: string; tradeId: number | null; message: string }>;
}

interface IntradayTradeRow {
  id: number;
  ticker: string;
  entered_at: string;
  entry_price: number;
  stop_price: number;
  target_price: number;
  modeled_slippage_bps: number;
  status: string;
  max_adverse_excursion_bps: number | null;
  max_favorable_excursion_bps: number | null;
}

function pnlBpsFromMid(entry: number, mid: number): number {
  if (entry <= 0) return 0;
  return Math.round(((mid - entry) / entry) * 10_000);
}

export async function runIntradayTickJob(): Promise<IntradayTickResult> {
  // Use a separate run-log job name so this can run on a different schedule
  // than the EOD swing pipeline without colliding with run-lock.
  return withRunLog('intraday_tick', {}, async () => {
    if (!env.tradingMode.includes('intraday_paper')) {
      return {
        tradesScanned: 0,
        ticksRecorded: 0,
        closedThisTick: 0,
        rejectedWideSpread: 0,
        staleQuotesSkipped: 0,
        quoteUnavailable: 0,
        newlyOpened: 0,
        entriesEvaluated: 0,
        entriesRejected: [],
        errors: []
      };
    }

    const supabase = getSupabaseAdmin();
    const client = getIntradayClient();
    const { data, error } = await supabase
      .from('intraday_paper_trades')
      .select('id,ticker,entered_at,entry_price,stop_price,target_price,modeled_slippage_bps,status,max_adverse_excursion_bps,max_favorable_excursion_bps')
      .eq('status', 'open');
    if (error) throw error;
    const trades = (data ?? []) as unknown as IntradayTradeRow[];

    const errors: IntradayTickResult['errors'] = [];
    let ticksRecorded = 0;
    let closedThisTick = 0;
    let rejectedWideSpread = 0;
    let staleQuotesSkipped = 0;
    let quoteUnavailable = 0;

    for (const trade of trades) {
      try {
        const quote = await client.getQuote(trade.ticker);
        if (!quote) {
          quoteUnavailable += 1;
          continue;
        }
        // Skip processing this trade entirely on stale quotes. We do NOT
        // record a progression row from stale data because that would persist
        // a fake "current" P&L. The next non-stale tick will pick it up.
        if (isQuoteStale(quote, env.intradayMaxQuoteAgeSeconds)) {
          staleQuotesSkipped += 1;
          continue;
        }
        const decision = decideSlippage(quote, { maxSpreadBps: env.intradayMaxSpreadBps });
        const spread = computeSpread(quote);

        const pnlBps = pnlBpsFromMid(trade.entry_price, spread.midPrice);
        const minMae = Math.min(trade.max_adverse_excursion_bps ?? Number.POSITIVE_INFINITY, pnlBps);
        const maxMfe = Math.max(trade.max_favorable_excursion_bps ?? Number.NEGATIVE_INFINITY, pnlBps);

        const touchedStop = quote.bid <= trade.stop_price;
        const touchedTarget = quote.ask >= trade.target_price;
        const minutesOpen = (Date.now() - new Date(trade.entered_at).getTime()) / 60_000;
        const overTimeStop = minutesOpen >= env.intradayTimeStopMinutes;

        const { error: progErr } = await supabase.from('intraday_progression').insert({
          intraday_trade_id: trade.id,
          observed_at: quote.observedAt,
          bid: quote.bid,
          ask: quote.ask,
          last_price: quote.lastPrice,
          spread_bps: spread.spreadBps,
          pnl_pct_net: round(pnlBps / 10_000 - decision.roundTripSlippageBps / 10_000, 6),
          touched_stop: touchedStop,
          touched_target: touchedTarget
        });
        if (progErr) throw progErr;
        ticksRecorded += 1;

        let nextStatus: 'open' | 'stopped' | 'target_hit' | 'time_closed' | 'rejected_wide_spread' = 'open';
        let exitReason: string | null = null;
        let exitPrice: number | null = null;

        if (!decision.acceptable) {
          // Wide spread: refuse to close at unfavorable fill, just record and
          // wait. The trade only converts to rejected_wide_spread if we have
          // also exceeded the time stop.
          rejectedWideSpread += 1;
          if (overTimeStop) {
            nextStatus = 'rejected_wide_spread';
            exitReason = decision.reason;
            exitPrice = spread.midPrice;
          }
        } else if (touchedStop) {
          nextStatus = 'stopped';
          exitReason = 'stop';
          exitPrice = decision.paperSellFill;
        } else if (touchedTarget) {
          nextStatus = 'target_hit';
          exitReason = 'target';
          exitPrice = decision.paperSellFill;
        } else if (overTimeStop) {
          nextStatus = 'time_closed';
          exitReason = 'time_stop';
          exitPrice = decision.paperSellFill;
        }

        if (nextStatus !== 'open' && exitPrice != null) {
          const { error: closeErr } = await supabase
            .from('intraday_paper_trades')
            .update({
              status: nextStatus,
              exited_at: new Date().toISOString(),
              exit_price: round(exitPrice, 4),
              exit_reason: exitReason,
              max_adverse_excursion_bps: minMae,
              max_favorable_excursion_bps: maxMfe
            })
            .eq('id', trade.id);
          if (closeErr) throw closeErr;
          closedThisTick += 1;
        } else {
          await supabase
            .from('intraday_paper_trades')
            .update({
              max_adverse_excursion_bps: minMae,
              max_favorable_excursion_bps: maxMfe
            })
            .eq('id', trade.id);
        }
      } catch (err) {
        errors.push({ ticker: trade.ticker, tradeId: trade.id, message: err instanceof Error ? err.message : String(err) });
      }
    }

    const entry = await openIntradayEntriesForTodayBuys();

    return {
      tradesScanned: trades.length,
      ticksRecorded,
      closedThisTick,
      rejectedWideSpread,
      staleQuotesSkipped,
      quoteUnavailable,
      newlyOpened: entry.newlyOpened,
      entriesEvaluated: entry.entriesEvaluated,
      entriesRejected: entry.entriesRejected,
      errors: errors.concat(entry.errors)
    };
  });
}

interface EntryPhaseResult {
  newlyOpened: number;
  entriesEvaluated: number;
  entriesRejected: Array<{ ticker: string; reason: string }>;
  errors: Array<{ ticker: string; tradeId: null; message: string }>;
}

// Open intraday paper trades for today's BUY-tier swing candidates that don't
// already have an open intraday position. This is intentionally minimal: the
// intraday system rides on the same selection pipeline as EOD swing for now.
// A future PR can add purely intraday signal sources (gap fades, ORB breakouts)
// without disturbing the EOD path.
async function openIntradayEntriesForTodayBuys(): Promise<EntryPhaseResult> {
  const supabase = getSupabaseAdmin();
  const today = todayInNewYork();
  const errors: EntryPhaseResult['errors'] = [];
  const entriesRejected: EntryPhaseResult['entriesRejected'] = [];

  const { data: buyRows, error: buyErr } = await supabase
    .from('paper_trades')
    .select('ticker,signal_date,effective_tier')
    .eq('signal_date', today)
    .eq('effective_tier', 'BUY');
  if (buyErr) {
    errors.push({ ticker: '*', tradeId: null, message: `select_buys: ${buyErr.message}` });
    return { newlyOpened: 0, entriesEvaluated: 0, entriesRejected, errors };
  }
  const buyTickers = Array.from(new Set((buyRows ?? []).map((r) => (r as unknown as { ticker: string }).ticker)));
  if (buyTickers.length === 0) {
    return { newlyOpened: 0, entriesEvaluated: 0, entriesRejected, errors };
  }

  const { data: openIntra, error: openErr } = await supabase
    .from('intraday_paper_trades')
    .select('ticker')
    .eq('status', 'open')
    .in('ticker', buyTickers);
  if (openErr) {
    errors.push({ ticker: '*', tradeId: null, message: `select_open_intra: ${openErr.message}` });
    return { newlyOpened: 0, entriesEvaluated: 0, entriesRejected, errors };
  }
  const alreadyOpen = new Set((openIntra ?? []).map((r) => (r as unknown as { ticker: string }).ticker));
  const candidates = buyTickers.filter((t) => !alreadyOpen.has(t));

  const client = getIntradayClient();
  let newlyOpened = 0;
  let entriesEvaluated = 0;
  for (const ticker of candidates) {
    entriesEvaluated += 1;
    try {
      const outcome = await evaluateOpenIntradayTrade({
        ticker,
        source: 'eod_swing_buy',
        client,
        options: {
          maxSpreadBps: env.intradayMaxSpreadBps,
          maxQuoteAgeSeconds: env.intradayMaxQuoteAgeSeconds
        }
      });
      if (!outcome.opened || !outcome.decision || !outcome.quote) {
        entriesRejected.push({ ticker, reason: outcome.reason });
        continue;
      }

      const { data: signal, error: sigErr } = await supabase
        .from('intraday_signals')
        .insert({
          ticker,
          source: 'eod_swing_buy',
          bid: outcome.quote.bid,
          ask: outcome.quote.ask,
          last_price: outcome.quote.lastPrice,
          payload: { decision: outcome.decision }
        })
        .select('id')
        .single();
      if (sigErr) throw sigErr;

      const signalRow = signal as unknown as { id: number };
      const { error: tradeErr } = await supabase.from('intraday_paper_trades').insert({
        signal_id: signalRow.id,
        ticker,
        entered_at: new Date().toISOString(),
        entry_price: round(outcome.decision.entryPrice, 4),
        stop_price: round(outcome.decision.stopPrice, 4),
        target_price: round(outcome.decision.targetPrice, 4),
        modeled_slippage_bps: outcome.decision.modeledSlippageBps,
        spread_bps_at_entry: outcome.decision.spreadBpsAtEntry,
        status: 'open',
        notes: 'Auto-opened by intraday_tick from EOD BUY tier'
      });
      if (tradeErr) {
        // Trade insert failed after we already wrote the parent
        // intraday_signals row; clean up the orphan so the dashboard
        // doesn't show a "signal observed" row that has no trade.
        await supabase.from('intraday_signals').delete().eq('id', signalRow.id);

        // Postgres unique-violation: the partial unique index on
        // (ticker WHERE status='open') saved us from a race where another
        // tick (or a scheduler retry) opened the same ticker between our
        // SELECT and INSERT. Treat it as "already open" rather than failing.
        if ((tradeErr as { code?: string }).code === '23505') {
          entriesRejected.push({ ticker, reason: 'already_open_race' });
          continue;
        }
        throw tradeErr;
      }
      newlyOpened += 1;
    } catch (err) {
      errors.push({ ticker, tradeId: null, message: err instanceof Error ? err.message : String(err) });
    }
  }

  return { newlyOpened, entriesEvaluated, entriesRejected, errors };
}
