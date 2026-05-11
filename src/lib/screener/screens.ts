import { env } from '@/lib/env';
import { atr, averageDollarVolume, averageVolume, maxHigh, pctChange } from './indicators';
import type { DailyBar, ScreenSource, TickerMetrics } from '@/types/app';

export function computeMetricsForTicker(ticker: string, bars: DailyBar[]): TickerMetrics | null {
  const sorted = [...bars].sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length < 21) return null;

  const latestBar = sorted[sorted.length - 1];
  const previousBar = sorted[sorted.length - 2];
  const fiveBack = sorted[Math.max(0, sorted.length - 6)];
  const prior20 = sorted.slice(0, -1).slice(-20);
  const high20 = maxHigh(sorted.slice(0, -1), 20);
  const avgVol = averageVolume(prior20, 20);
  const avgDollarVol = averageDollarVolume(prior20, 20);
  const atr14 = atr(sorted.slice(0, -1), 14) || (latestBar.high - latestBar.low);

  return {
    ticker,
    date: latestBar.date,
    latestBar,
    previousClose: previousBar.close,
    pctChange: pctChange(previousBar.close, latestBar.close),
    pctChange5d: pctChange(fiveBack.close, latestBar.close),
    relVolume: avgVol > 0 ? latestBar.volume / avgVol : 0,
    avgVolume20d: avgVol,
    avgDollarVolume20d: avgDollarVol,
    atr14,
    drawdownFrom20dHighPct: pctChange(high20, latestBar.close),
    signalDayLow: latestBar.low
  };
}

export function evaluateScreens(metrics: TickerMetrics): ScreenSource[] {
  const screens: ScreenSource[] = [];

  const screenA = metrics.pctChange <= env.screenADropPct && metrics.relVolume >= env.screenARelVolume;
  const screenB =
    metrics.pctChange5d <= env.screenB5dDropPct &&
    metrics.drawdownFrom20dHighPct <= env.screenBDrawdown20dPct &&
    metrics.relVolume >= 1.0 &&
    metrics.pctChange <= -2;

  if (screenA) screens.push('screen_a');
  if (screenB) screens.push('screen_b');
  return screens;
}
