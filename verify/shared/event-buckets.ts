/** Independent event calendar arithmetic. Inputs contain only projected usage. */
type Json = Record<string, any>;
export type EventBucket = { day: string | null; hour: number | null; model: string; executionKind: string; inputTokens: number; uncachedInputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; outputTokens: number; reasoningOutputTokens: number; totalUsd: number; calls: number };
const calendars = new Map<string, Intl.DateTimeFormat>();
export function addEvent(buckets: Map<string, EventBucket>, event: { at: string | null; model: string; executionKind: string; tokens: Json; totalUsd: number; calls: number }, zone = 'Europe/London'): void {
  const ms = event.at ? Date.parse(event.at) : NaN;
  let calendar = calendars.get(zone); if (!calendar) { calendar = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }); calendars.set(zone, calendar); }
  const parts = Number.isFinite(ms) ? calendar.formatToParts(ms) : [];
  const part = (type: string) => parts.find(p => p.type === type)?.value;
  const day = parts.length ? `${part('year')}-${part('month')}-${part('day')}` : null, hour = parts.length ? Number(part('hour')) : null;
  const key = JSON.stringify([day, hour, event.model, event.executionKind]);
  let row = buckets.get(key);
  if (!row) { row = { day, hour, model: event.model, executionKind: event.executionKind, inputTokens: 0, uncachedInputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalUsd: 0, calls: 0 }; buckets.set(key, row); }
  for (const field of ['inputTokens', 'uncachedInputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens'] as const) {
    if (!Number.isSafeInteger(event.tokens[field]) || event.tokens[field] < 0) throw new Error('Invalid independent event counter.');
    row[field] += event.tokens[field];
  }
  if (!Number.isFinite(event.totalUsd) || !Number.isSafeInteger(event.calls)) throw new Error('Invalid independent event amount.');
  row.totalUsd += event.totalUsd; row.calls += event.calls;
}
export function compareEventBuckets(session: Json, expected: EventBucket[]) {
  const differences: Json[] = [], actual = new Map<string, EventBucket>();
  const v = session.velocity;
  if (!v || !Array.isArray(v.buckets) || !Array.isArray(v.undated) || !Array.isArray(v.dimensions)) return [{ sessionKey: session.sessionKey, field: 'velocity.unavailable' }];
  for (const [day, hour, index, values] of v.buckets) {
    const dimension = v.dimensions[index]; if (!dimension || !Array.isArray(values)) throw new Error('Invalid public velocity bucket.');
    const key = JSON.stringify([day, hour, dimension.model, dimension.executionKind]);
    const row = actual.get(key) ?? { day, hour, model: dimension.model, executionKind: dimension.executionKind, totalUsd: 0, inputTokens: 0, uncachedInputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, calls: 0 };
    for (const [i, field] of ['totalUsd', 'inputTokens', 'uncachedInputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'calls'].entries()) { if (!Number.isFinite(values[i])) throw new Error('Invalid velocity scalar.'); (row as Json)[field!] += values[i]; }
    actual.set(key, row);
  }
  for (const [index, values] of v.undated) {
    const dimension = v.dimensions[index]; if (!dimension || !Array.isArray(values)) throw new Error('Invalid public undated bucket.');
    const row: EventBucket = { day: null, hour: null, model: dimension.model, executionKind: dimension.executionKind, totalUsd: values[0], inputTokens: values[1], uncachedInputTokens: values[2], cachedInputTokens: values[3], cacheWriteInputTokens: values[4], outputTokens: values[5], reasoningOutputTokens: values[6], calls: values[7] };
    const key = JSON.stringify([null, null, dimension.model, dimension.executionKind]); if (actual.has(key)) throw new Error('Duplicate public undated bucket.'); actual.set(key, row);
  }
  const wanted = new Map(expected.map(row => [JSON.stringify([row.day, row.hour, row.model, row.executionKind]), row]));
  for (const key of new Set([...actual.keys(), ...wanted.keys()])) {
    const a = actual.get(key), b = wanted.get(key), cell = a ?? b!;
    for (const field of ['totalUsd', 'inputTokens', 'uncachedInputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'calls'] as const) {
      const value = a?.[field] ?? 0, expectedValue = b?.[field] ?? 0;
      if (!Number.isFinite(value) || !Number.isFinite(expectedValue) || (field === 'totalUsd' ? Math.abs(value - expectedValue) > 1e-7 : value !== expectedValue)) differences.push({ sessionKey: session.sessionKey, field: `velocity.${field}`, day: cell.day, hour: cell.hour, model: cell.model, executionKind: cell.executionKind, actual: value, expected: expectedValue });
    }
  }
  return differences;
}
