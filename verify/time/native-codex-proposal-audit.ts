/** Saved-cache diagnostic of ordinary native requests accepted by the proposed exact-state rule.
 * This is a bounded proposal-impact audit, not a raw reread or new ownership ground truth.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
process.on('uncaughtException', () => { process.stderr.write('Native proposal audit failed; local details suppressed.\n'); process.exit(1); });
const read = (p: string): any => JSON.parse(readFileSync(p, 'utf8'));
const native = read('.lane/time-native-codex-audit.json');
const legacy = read('.lane/codex-observations.json');
const counter = read('.lane/codex-counter-oracle.json');
const frozen = read('.lane/codex-native-independent.json');
const aliases = new Map<string, string>(read('.lane/codex-reconciliation.json').legacyKeyMatches.map((r: any) => [r.providerKey, r.conductorKey]));
const canonical = (key: string) => aliases.get(key) ?? key;
const stable = new Set<string>(counter.sessions.map((s: any) => s.sessionKey));
const live = new Set<string>(frozen.liveSessionKeys);
const rates = read('data/rate-cards.json').models;
const tuple = (u: any): number[] => [u.inputTokens, u.cachedInputTokens, u.outputTokens, u.reasoningOutputTokens];
const state = (total: number[], last: number[]) => JSON.stringify([total, last]);
const stateKey = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 12);
const files = new Map<number, any>(legacy.fileMetadata.map((f: any) => [f.fileIndex, f]));
const model = (m: string, fileIndex?: number): string => m === '<unknown>' && fileIndex !== undefined && files.get(fileIndex)?.models.length === 1 ? files.get(fileIndex).models[0] : m;
const london = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' });
const day = (time: string | null, zone: string): string => time ? zone === 'UTC' ? time.slice(0, 10) : london.format(new Date(time)) : '<undated>';
const londonClock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23' });
const hour = (time: string | null, zone: string): string => time ? `${day(time, zone)}T${zone === 'UTC' ? time.slice(11, 13) : londonClock.format(new Date(time))}` : '<undated>';
const price = (u: number[], m: string): number => {
  const r = rates[m]; if (!r) return 0;
  const long = r.longContext && u[0]! > r.longContext.thresholdInputTokens;
  return (Math.max(0, u[0]! - u[1]!) * r.inputPerMillion * (long ? r.longContext.inputMultiplier : 1) + u[1]! * r.cachedInputPerMillion * (long ? r.longContext.inputMultiplier : 1) + u[2]! * r.outputPerMillion * (long ? r.longContext.outputMultiplier : 1)) / 1e6;
};
const winners = new Map<string, any>();
for (const raw of legacy.observations) {
  if (raw.last.inputTokens + raw.last.outputTokens <= 0) continue;
  const row = { ...raw, sessionKey: canonical(raw.sessionKey) };
  const key = state(tuple(row.total), tuple(row.last)), old = winners.get(key);
  const a = row.broadScore ?? Infinity, b = old?.broadScore ?? Infinity;
  if (!old || a < b || a === b && (row.time < old.time || row.time === old.time && row.fileIndex < old.fileIndex)) winners.set(key, row);
}
const requestFiles = new Map<string, number[]>();
for (const r of legacy.requestRecords) {
  const key = JSON.stringify([canonical(r.sessionKey), r.responseKey, r.time]);
  const group = requestFiles.get(key) ?? []; group.push(r.fileIndex); requestFiles.set(key, group);
}
const groups = new Map<string, any[]>();
const acceptedByFile = new Map<number, any[]>();
const counts = { ordinaryNativeRecords: 0, exactStateAccepted: 0, ignoredDifferentOrAbsentState: 0, unjoinedNativeFile: 0, ambiguousNativeFileModels: 0, sourceAfterCutoff: 0, legacyWinnerOutsideStableScope: 0, timeChanged: 0, utcHourChanged: 0, londonHourChanged: 0, utcDayChanged: 0, londonDayChanged: 0, utcMonthChanged: 0, londonMonthChanged: 0, ownerChanged: 0, modelChanged: 0 };
const differences: any[] = [];
for (const n of native.native) {
  if (n.compactionResponse || live.has(n.sessionKey) || !stable.has(n.sessionKey)) continue;
  counts.ordinaryNativeRecords++;
  const key = state(n.threadUsage, n.usage), old = winners.get(key);
  if (!old) { counts.ignoredDifferentOrAbsentState++; continue; }
  counts.exactStateAccepted++;
  const candidateFiles = requestFiles.get(JSON.stringify([n.sessionKey, n.responseKey, n.time])) ?? [];
  for (const fileIndex of new Set(candidateFiles)) { const list = acceptedByFile.get(fileIndex) ?? []; list.push(n); acceptedByFile.set(fileIndex, list); }
  if (!candidateFiles.length) counts.unjoinedNativeFile++;
  const candidateModels = new Set(candidateFiles.map(i => model(n.model, i)));
  if (candidateModels.size > 1) counts.ambiguousNativeFileModels++;
  const nativeModel = [...candidateModels][0] ?? n.model;
  const legacyModel = model(old.model, old.fileIndex);
  const nativeValue = price(n.usage, nativeModel), legacyValue = price(tuple(old.last), legacyModel);
  const a = { sessionKey: n.sessionKey, responseKey: n.responseKey, time: n.time, utcHour: hour(n.time, 'UTC'), londonHour: hour(n.time, 'Europe/London'), utcDay: day(n.time, 'UTC'), londonDay: day(n.time, 'Europe/London'), model: nativeModel, valueUsd: nativeValue, usage: n.usage };
  const b = { sessionKey: old.sessionKey, time: old.time, utcHour: hour(old.time, 'UTC'), londonHour: hour(old.time, 'Europe/London'), utcDay: day(old.time, 'UTC'), londonDay: day(old.time, 'Europe/London'), model: legacyModel, valueUsd: legacyValue, usage: tuple(old.last), broadActivity: old.broadType, broadScore: old.broadScore };
  const flags = { time: a.time !== b.time, utcHour: a.utcHour !== b.utcHour, londonHour: a.londonHour !== b.londonHour, utcDay: a.utcDay !== b.utcDay, londonDay: a.londonDay !== b.londonDay, utcMonth: a.utcDay.slice(0, 7) !== b.utcDay.slice(0, 7), londonMonth: a.londonDay.slice(0, 7) !== b.londonDay.slice(0, 7), owner: a.sessionKey !== b.sessionKey, model: a.model !== b.model };
  for (const [flag, changed] of Object.entries(flags)) if (changed) counts[`${flag}Changed` as keyof typeof counts]++;
  if (!stable.has(old.sessionKey) || live.has(old.sessionKey)) counts.legacyWinnerOutsideStableScope++;
  if (!n.sourceExistedBeforeReference) counts.sourceAfterCutoff++;
  const group = groups.get(key) ?? []; group.push({ native: a, legacy: b }); groups.set(key, group);
  if (flags.utcHour || flags.londonHour || flags.utcDay || flags.londonDay || flags.owner || flags.model) differences.push({ stateKey: stateKey(key), flags, native: a, legacy: b });
}
const zero = () => ({ calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, valueUsd: 0 });
type Amount = ReturnType<typeof zero>;
const add = (to: Amount, item: any, sign: number) => { to.calls += sign; to.inputTokens += sign * item.usage[0]; to.cachedInputTokens += sign * item.usage[1]; to.outputTokens += sign * item.usage[2]; to.valueUsd += sign * item.valueUsd; };
const total = zero();
const by: Record<string, Record<string, Amount>> = { sessions: {}, models: {}, utcHours: {}, londonHours: {}, utcDays: {}, londonDays: {}, utcMonths: {}, londonMonths: {} };
const apply = (row: any, sign: number) => {
  add(total, row, sign);
  for (const [kind, key] of [['sessions', row.sessionKey], ['models', row.model], ['utcHours', row.utcHour], ['londonHours', row.londonHour], ['utcDays', row.utcDay], ['londonDays', row.londonDay], ['utcMonths', row.utcDay.slice(0, 7)], ['londonMonths', row.londonDay.slice(0, 7)]]) add(by[kind]![key] ??= zero(), row, sign);
};
const collisions: any[] = [];
for (const [key, group] of groups) {
  apply(group[0].legacy, -1);
  for (const row of group) apply(row.native, 1);
  if (group.length > 1) collisions.push({ stateKey: stateKey(key), legacyOwner: group[0].legacy.sessionKey, responses: group.map(r => ({ sessionKey: r.native.sessionKey, responseKey: r.native.responseKey, time: r.native.time })) });
}
for (const [kind, values] of Object.entries(by)) by[kind] = Object.fromEntries(Object.entries(values).filter(([, v]) => v.calls || v.inputTokens || v.outputTokens || v.cachedInputTokens || Math.abs(v.valueUsd) > 1e-6));
const fallbackSafety = { legacyObservations: legacy.observations.length, backwardsLegacyObservationTimes: 0, zeroLastObservations: 0, positiveMonotonicFallbacks: 0, positiveFallbacksInAcceptedNativeFiles: 0, acceptedNativeResponsesInsidePositiveFallbackInterval: 0, positiveFallbackRows: [] as any[] };
const previousByFile = new Map<number, any>();
for (const row of legacy.observations) {
  const prev = previousByFile.get(row.fileIndex);
  if (prev && row.time < prev.time) fallbackSafety.backwardsLegacyObservationTimes++;
  previousByFile.set(row.fileIndex, row);
  if (row.last.inputTokens + row.last.outputTokens > 0) continue;
  fallbackSafety.zeroLastObservations++;
  if (!prev || !Object.keys(row.total).every(k => row.total[k] >= prev.total[k])) continue;
  const delta = tuple(row.total).map((v, i) => v - tuple(prev.total)[i]!);
  if (delta[0]! + delta[2]! <= 0) continue;
  fallbackSafety.positiveMonotonicFallbacks++;
  const sameFile = acceptedByFile.get(row.fileIndex) ?? [];
  if (sameFile.length) fallbackSafety.positiveFallbacksInAcceptedNativeFiles++;
  const interval = sameFile.filter(n => n.time >= prev.time && n.time <= row.time);
  fallbackSafety.acceptedNativeResponsesInsidePositiveFallbackInterval += interval.length;
  fallbackSafety.positiveFallbackRows.push({ sessionKey: canonical(row.sessionKey), previousTime: prev.time, time: row.time, usageDelta: delta, acceptedNativeInFile: sameFile.length, acceptedNativeInClosedInterval: interval.map(n => ({ responseKey: n.responseKey, time: n.time })) });
}
const result = { provenance: { native: '.lane/time-native-codex-audit.json', legacy: '.lane/codex-observations.json', frozen: '.lane/codex-native-independent.json', stableCounter: '.lane/codex-counter-oracle.json', rates: 'data/rate-cards.json', method: 'Global exact native thread-total/usage match; legacy broad activity winner; explicit native thread owner, native timestamp and turn-context model; complete native request identity deduplication already verified independently.', limitation: 'Bounded proposal diagnostic only; does not replay pruning/index retainers, session database model fallbacks, or native records outside frozen independently reread scope. Fallback safety examines the saved file-local observation union and all accepted native source file joins.' }, counts, exactStates: groups.size, collisions, netOrdinaryReplacementDelta: total, by, differences, fallbackSafety };
writeFileSync('.lane/time-native-codex-proposal-audit.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ counts, exactStates: groups.size, collisions, netOrdinaryReplacementDelta: total, by, differences, fallbackSafety }, null, 2));
