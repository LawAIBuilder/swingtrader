import { env } from '@/lib/env';
import type { TickerDetails, TickerMetrics } from '@/types/app';

const allowedPrimaryExchanges = new Set(['XNYS', 'XNAS', 'NYSE', 'NASDAQ', 'NAS', 'NYS']);
const blockedCountries = new Set(['CN', 'CHN', 'HK', 'HKG', 'China', 'Hong Kong']);

const leveragedEtfNameHints = [
  '2x', '3x', 'ultra', 'ultrapro', 'daily bull', 'daily bear', 'bear 2x', 'bear 3x',
  'bull 2x', 'bull 3x', 'leveraged', 'inverse', 'proshares ultra', 'direxion daily'
];

const leveragedEtfTickers = new Set([
  'TQQQ', 'SQQQ', 'SPXL', 'SPXS', 'SOXL', 'SOXS', 'FAS', 'FAZ', 'LABU', 'LABD',
  'UVXY', 'SVXY', 'BOIL', 'KOLD', 'TECL', 'TECS', 'UPRO', 'SPXU', 'TNA', 'TZA'
]);

export function isLikelyLeveragedEtf(details: TickerDetails): boolean {
  if (leveragedEtfTickers.has(details.ticker.toUpperCase())) return true;
  const name = (details.name ?? '').toLowerCase();
  return leveragedEtfNameHints.some((hint) => name.includes(hint));
}

export function passesUniverseFilter(metrics: TickerMetrics, details: TickerDetails): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (details.active === false) reasons.push('inactive');
  if (details.type && details.type !== 'CS') reasons.push(`not_common_stock:${details.type}`);
  if (details.primaryExchange && !allowedPrimaryExchanges.has(details.primaryExchange)) {
    reasons.push(`exchange:${details.primaryExchange}`);
  }
  if (details.country && blockedCountries.has(details.country)) reasons.push(`blocked_country:${details.country}`);
  if (isLikelyLeveragedEtf(details)) reasons.push('leveraged_etf');

  const marketCap = details.marketCap ?? 0;
  if (marketCap < env.minMarketCap) reasons.push(`market_cap_below_${env.minMarketCap}`);
  if (metrics.latestBar.close < env.minPrice || metrics.latestBar.close > env.maxPrice) reasons.push('price_out_of_range');
  if (metrics.avgDollarVolume20d < env.minAvgDollarVolume) reasons.push('avg_dollar_volume_low');

  return { ok: reasons.length === 0, reasons };
}
