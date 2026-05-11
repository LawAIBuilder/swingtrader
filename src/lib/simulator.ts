import { env } from '@/lib/env';
import type { DailyBar, FinalizedPaperTrade } from '@/types/app';
import { grossPnlPct, netPnlPct } from './risk';
import { round } from './utils/numbers';

export interface DaySimulationResult {
  touchedStop: boolean;
  touchedTarget: boolean;
  isAmbiguous: boolean;
  exitNow: boolean;
  exitPrice: number | null;
  exitReason: string | null;
  status: 'open' | 'stopped' | 'target_hit' | 'time_closed';
  pnlPctGross: number;
  pnlPctNet: number;
}

export function simulateTradeDay(trade: FinalizedPaperTrade, bar: DailyBar, dayNumber: number): DaySimulationResult {
  const touchedTarget = bar.high >= trade.target_price;
  const touchedStop = bar.low <= trade.stop_price;
  const isAmbiguous = touchedTarget && touchedStop;

  let exitNow = false;
  let exitPrice: number | null = null;
  let exitReason: string | null = null;
  let status: DaySimulationResult['status'] = 'open';

  if (isAmbiguous) {
    if (bar.open <= trade.stop_price) {
      exitNow = true;
      exitPrice = bar.open;
      exitReason = 'gap_stop';
      status = 'stopped';
    } else if (bar.open >= trade.target_price) {
      exitNow = true;
      exitPrice = bar.open;
      exitReason = 'gap_target';
      status = 'target_hit';
    } else {
      exitNow = true;
      exitPrice = trade.stop_price;
      exitReason = 'stop_conservative';
      status = 'stopped';
    }
  } else if (touchedStop) {
    exitNow = true;
    exitPrice = bar.open <= trade.stop_price ? bar.open : trade.stop_price;
    exitReason = bar.open <= trade.stop_price ? 'gap_stop' : 'stop';
    status = 'stopped';
  } else if (touchedTarget) {
    exitNow = true;
    exitPrice = bar.open >= trade.target_price ? bar.open : trade.target_price;
    exitReason = bar.open >= trade.target_price ? 'gap_target' : 'target';
    status = 'target_hit';
  } else if (dayNumber >= env.timeStopDays) {
    exitNow = true;
    exitPrice = bar.close;
    exitReason = 'time_stop';
    status = 'time_closed';
  }

  const markPrice = exitPrice ?? bar.close;
  return {
    touchedStop,
    touchedTarget,
    isAmbiguous,
    exitNow,
    exitPrice,
    exitReason,
    status,
    pnlPctGross: round(grossPnlPct(trade.entry_price, markPrice), 6),
    pnlPctNet: round(netPnlPct(trade.entry_price, markPrice, trade.modeled_slippage_bps), 6)
  };
}
