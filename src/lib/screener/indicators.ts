import type { DailyBar } from '@/types/app';

export function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function averageVolume(bars: DailyBar[], lookback = 20): number {
  const slice = bars.slice(-lookback);
  return average(slice.map((b) => b.volume));
}

export function averageDollarVolume(bars: DailyBar[], lookback = 20): number {
  const slice = bars.slice(-lookback);
  return average(slice.map((b) => b.volume * b.close));
}

export function trueRange(current: DailyBar, previousClose: number): number {
  return Math.max(
    current.high - current.low,
    Math.abs(current.high - previousClose),
    Math.abs(current.low - previousClose)
  );
}

export function atr(bars: DailyBar[], lookback = 14): number {
  if (bars.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i += 1) {
    trs.push(trueRange(bars[i], bars[i - 1].close));
  }
  return average(trs.slice(-lookback));
}

export function pctChange(from: number, to: number): number {
  if (!Number.isFinite(from) || from === 0) return 0;
  return ((to - from) / from) * 100;
}

export function maxHigh(bars: DailyBar[], lookback = 20): number {
  return Math.max(...bars.slice(-lookback).map((b) => b.high));
}
