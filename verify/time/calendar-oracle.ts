// Independent calendar arithmetic. No production imports and no local content output.
export function instant(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  let text = value.trim().replace(' ', 'T');
  if (!/(?:Z|[+-]\d\d:\d\d)$/i.test(text)) text += 'Z';
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

export function calendarDay(value: unknown, timeZone = 'UTC'): string | null {
  const ms = typeof value === 'number' ? value : instant(value);
  if (ms === null || !Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(ms);
  const part = (type: string) => parts.find(p => p.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function inUtcWindow(value: unknown, since: string, until: string): boolean {
  const ms = instant(value), lo = instant(since), hi = instant(until);
  return ms !== null && lo !== null && hi !== null && ms >= lo && ms < hi + 86400000;
}
