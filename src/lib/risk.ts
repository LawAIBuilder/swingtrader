import type { ScreenedCandidate } from '@/types/app';
import { round } from './utils/numbers';

export interface StopTargetResult {
  stopDistance: number;
  stopPrice: number;
  targetPrice: number;
}

export interface SlippageResult {
  liquidityBucket: 'large_liquid' | 'mid' | 'small_volatile';
  modeledSlippageBps: number;
}

export function computeStopAndTarget(entry: number, atr14: number, signalDayLow: number): StopTargetResult {
  const atrDistance = 1.5 * atr14;
  const structureDistance = Math.max(0.01, entry - signalDayLow + 0.10);
  const stopDistance = Math.max(atrDistance, structureDistance);
  return {
    stopDistance: round(stopDistance, 4),
    stopPrice: round(entry - stopDistance, 4),
    targetPrice: round(entry + 2 * stopDistance, 4)
  };
}

export function computeSlippage(candidate: Pick<ScreenedCandidate, 'marketCap' | 'avgDollarVolume20d'>): SlippageResult {
  if (candidate.marketCap > 10_000_000_000 && candidate.avgDollarVolume20d > 100_000_000) {
    return { liquidityBucket: 'large_liquid', modeledSlippageBps: 5 };
  }
  if (candidate.marketCap > 2_000_000_000 && candidate.avgDollarVolume20d > 20_000_000) {
    return { liquidityBucket: 'mid', modeledSlippageBps: 15 };
  }
  return { liquidityBucket: 'small_volatile', modeledSlippageBps: 40 };
}

export function grossPnlPct(entry: number, exit: number): number {
  return (exit - entry) / entry;
}

export function netPnlPct(entry: number, exit: number, slippageBps: number): number {
  return grossPnlPct(entry, exit) - (2 * slippageBps) / 10_000;
}
