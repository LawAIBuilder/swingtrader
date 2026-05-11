export function round(value: number, decimals = 4): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

export function pct(value: number | null | undefined, decimals = 2): string {
  if (value == null || Number.isNaN(value)) return '-';
  return `${(value * 100).toFixed(decimals)}%`;
}

export function pctAlready(value: number | null | undefined, decimals = 2): string {
  if (value == null || Number.isNaN(value)) return '-';
  return `${value.toFixed(decimals)}%`;
}

export function money(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '-';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

export function compactNumber(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '-';
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}
