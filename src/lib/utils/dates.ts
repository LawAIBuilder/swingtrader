export function toISODate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function fromISODate(date: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function addDays(date: string, days: number): string {
  const d = fromISODate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return toISODate(d);
}

export function isWeekend(date: string): boolean {
  const day = fromISODate(date).getUTCDay();
  return day === 0 || day === 6;
}

export function previousBusinessDay(date: string): string {
  let d = addDays(date, -1);
  while (isWeekend(d)) d = addDays(d, -1);
  return d;
}

export function nextBusinessDay(date: string): string {
  let d = addDays(date, 1);
  while (isWeekend(d)) d = addDays(d, 1);
  return d;
}

export function businessDatesBack(endDate: string, count: number): string[] {
  const dates: string[] = [];
  let d = endDate;
  while (dates.length < count) {
    if (!isWeekend(d)) dates.push(d);
    d = addDays(d, -1);
  }
  return dates.reverse();
}

export function calendarDaysBack(date: string, days: number): string {
  return addDays(date, -Math.abs(days));
}

export function todayInNewYork(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const d = parts.find((p) => p.type === 'day')?.value;
  return `${y}-${m}-${d}`;
}

export function daysBetween(start: string, end: string): number {
  const ms = fromISODate(end).getTime() - fromISODate(start).getTime();
  return Math.round(ms / 86_400_000);
}
