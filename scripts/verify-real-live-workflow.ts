/** Independent live-change proof over the public workflow contract. No production
 * accounting imports. Installed-skill membership requires separate phase inventory
 * evidence; operational inventory counters, mix, comparisons and unknown fields stay strict. */
import { createHash } from 'node:crypto';
import { inventoryMemberKey, verifyInventorySnapshot, type InventoryCensus } from './verify-real-inventory.ts';
type Row = Record<string, any>;
const HOUR = 3_600_000, DAY = HOUR * 24;
const rows = (value: unknown): Row[] => { if (!Array.isArray(value)) throw new Error('Unavailable workflow rows.'); return value; };
const number = (value: unknown): number => { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('Unavailable workflow operand.'); return value; };
const integer = (value: unknown): number => { const n = number(value); if (!Number.isSafeInteger(n)) throw new Error('Invalid workflow count.'); return n; };
const timestamp = (value: unknown): number => { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value)) throw new Error('Invalid workflow time.'); const n = Date.parse(value); if (!Number.isFinite(n)) throw new Error('Invalid workflow time.'); return n; };
const iso = (n: number) => new Date(n).toISOString();
const sum = (values: Row[], pick: (row: Row) => unknown) => values.reduce((total, row) => total + number(pick(row)), 0);
function same(a: any, b: any, field = ''): boolean {
  if (typeof a === 'number' || typeof b === 'number') {
    if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) return false;
    if (a === b) return true;
    return /Usd$|^usd$/.test(field) ? Math.abs(a - b) <= 1e-7 + Math.max(Math.abs(a), Math.abs(b)) * 1e-12
      : /^(?:effectiveParallelism|turnsPerSession|perHumanTurn)$/.test(field) && Math.abs(a - b) <= 1e-12;
  }
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a).sort();
  return JSON.stringify(keys) === JSON.stringify(Object.keys(b).sort()) && keys.every(key => same(a[key], b[key], key));
}
function histogram(values: Row[]) {
  const counts = new Map<number, number>();
  for (const value of values) {
    let samples = 0;
    for (const bin of rows(value.bins)) {
      const v = integer(bin.value), count = integer(bin.count);
      if (!count) throw new Error('Empty workflow bin.');
      samples += count; counts.set(v, (counts.get(v) ?? 0) + count);
    }
    if (samples !== integer(value.samples)) throw new Error('Inconsistent workflow histogram.');
  }
  const bins = [...counts].sort(([a], [b]) => a - b).map(([value, count]) => ({ value, count }));
  const samples = bins.reduce((n, b) => n + b.count, 0);
  const rank = (fraction: number) => {
    let needed = Math.ceil(samples * fraction);
    if (!needed) return null;
    for (const bin of bins) { needed -= bin.count; if (needed <= 0) return bin.value; }
    throw new Error('Invalid workflow rank.');
  };
  return { bins, samples, p50: rank(.5), p95: rank(.95), max: bins.at(-1)?.value ?? null };
}
function intervals(workflow: Row): Array<[number, number]> {
  const ordered = rows(workflow.time.activeSpans).map(s => [timestamp(s.start), timestamp(s.end)] as [number, number]).sort(([a], [b]) => a - b);
  const result: Array<[number, number]> = [];
  for (const [a, b] of ordered) {
    if (b <= a) throw new Error('Invalid workflow span.');
    const previous = result.at(-1);
    if (previous && a <= previous[1]) previous[1] = Math.max(b, previous[1]);
    else result.push([a, b]);
  }
  if (result.reduce((n, [a, b]) => n + b - a, 0) !== integer(workflow.time.activeMilliseconds)) throw new Error('Inconsistent active workflow time.');
  return result;
}
/** Endpoint membership, rather than summed deltas, independently proves the
 * half-open union and forbids counting a session twice at its own boundaries. */
function concurrency(workflows: Row[]) {
  const events = new Map<number, { enter: number[]; leave: number[] }>();
  let eligibleSessions = 0;
  workflows.forEach((workflow, id) => {
    const spans = intervals(workflow); if (spans.length) eligibleSessions++;
    for (const [a, b] of spans) for (const [at, kind] of [[a, 'enter'], [b, 'leave']] as const) {
      const event = events.get(at) ?? { enter: [], leave: [] }; event[kind].push(id); events.set(at, event);
    }
  });
  const points = [...events.keys()].sort((a, b) => a - b), active = new Set<number>();
  const timeline: Row[] = [], days = new Map<string, Row>();
  let peak = 0, activeSessionMilliseconds = 0, wallClockActiveMilliseconds = 0;
  for (let i = 0; i < points.length; i++) {
    const start = points[i]!, event = events.get(start)!;
    for (const id of event.leave) active.delete(id);
    for (const id of event.enter) active.add(id);
    const end = points[i + 1]; if (end === undefined || !active.size) continue;
    peak = Math.max(peak, active.size);
    activeSessionMilliseconds += (end - start) * active.size; wallClockActiveMilliseconds += end - start;
    const previous = timeline.at(-1);
    if (previous?.end === iso(start) && previous.sessions === active.size) previous.end = iso(end);
    else timeline.push({ start: iso(start), end: iso(end), sessions: active.size });
    for (let dayStart = Math.floor(start / DAY) * DAY; dayStart < end; dayStart += DAY) {
      const duration = Math.min(dayStart + DAY, end) - Math.max(dayStart, start), day = iso(dayStart).slice(0, 10);
      const value = days.get(day) ?? { day, peak: 0, activeSessionMilliseconds: 0, wallClockActiveMilliseconds: 0 };
      value.peak = Math.max(value.peak, active.size); value.activeSessionMilliseconds += duration * active.size; value.wallClockActiveMilliseconds += duration; days.set(day, value);
    }
  }
  return { peak, activeSessionMilliseconds, wallClockActiveMilliseconds, effectiveParallelism: wallClockActiveMilliseconds >= 60_000 ? activeSessionMilliseconds / wallClockActiveMilliseconds : null,
    eligibleSessions, timeline, daily: [...days.values()] };
}
function patterns(workflows: Row[], asOfDay: string) {
  const cells = Array.from({ length: 168 }, (_, n) => ({ weekday: Math.floor(n / 24), hour: n % 24, activeMilliseconds: 0, apiEquivalentUsd: 0 }));
  const dates = new Set<number>();
  for (const workflow of workflows) {
    for (const [a, b] of intervals(workflow)) for (let hourStart = Math.floor(a / HOUR) * HOUR; hourStart < b; hourStart += HOUR) {
      const date = new Date(hourStart), index = date.getUTCDay() * 24 + date.getUTCHours();
      cells[index]!.activeMilliseconds += Math.min(b, hourStart + HOUR) - Math.max(a, hourStart);
      dates.add(Math.floor(hourStart / DAY));
    }
    for (const value of rows(workflow.valueByHour)) {
      const at = timestamp(value.hour), date = new Date(at);
      if (at % HOUR) throw new Error('Invalid workflow value hour.');
      cells[date.getUTCDay() * 24 + date.getUTCHours()]!.apiEquivalentUsd += number(value.usd);
    }
  }
  const sorted = [...dates].sort((a, b) => a - b);
  let longestStreakDays = 0, streak = 0, previous: number | undefined;
  for (const day of sorted) { streak = previous === day - 1 ? streak + 1 : 1; longestStreakDays = Math.max(longestStreakDays, streak); previous = day; }
  let day = Date.parse(`${asOfDay}T00:00:00Z`) / DAY, currentStreakDays = 0;
  if (!dates.has(day)) day--;
  while (dates.has(day--)) currentStreakDays++;
  return { timezone: 'UTC', cells, activeDays: dates.size, longestStreakDays, currentStreakDays, asOfDay,
    pricedRequests: sum(workflows, w => w.pricedRequests), timestampedPricedRequests: sum(workflows, w => w.timestampedPricedRequests) };
}
function derive(all: Row[], asOfDay: string, repositoryIds: string[]) {
  const supported = all.filter(s => s.workflow && s.transcript.status === 'ok'), workflows = supported.map(s => s.workflow), human = workflows.filter(w => w.humanTurns !== null);
  const humanTurns = sum(human, w => w.humanTurns);
  const steering: Row = { midTurnHumanTurns: 0, planEntries: 0, planItems: 0, queueOperations: { enqueue: 0, dequeue: 0, remove: 0, other: 0 }, queueReasons: { prompt: 0, interrupt: 0, completion: 0, cancellation: 0, other: 0, unspecified: 0 } };
  for (const key of ['midTurnHumanTurns', 'planEntries', 'planItems']) steering[key] = sum(workflows, w => w.steering[key]);
  for (const nested of ['queueOperations', 'queueReasons']) for (const key of Object.keys(steering[nested])) steering[nested][key] = sum(workflows, w => w.steering[nested][key]);
  const archetypes = Object.fromEntries(['quick', 'standard', 'deep', 'marathon', 'unavailable'].map(kind => [kind, workflows.filter(w => (w.archetype ?? 'unavailable') === kind).length]));
  if (Object.values(archetypes).reduce((a, b) => a + b, 0) !== workflows.length) throw new Error('Invalid workflow archetype.');
  const eligible = supported.filter(s => s.workflow.humanTurns !== null && (s.provider === 'codex' || s.workflow.coverage.contentRules));
  const eligibleHumanTurns = sum(eligible, s => s.workflow.humanTurns);
  const interruptionCounts = Object.fromEntries(['interrupted', 'replaced', 'other', 'subagentInterrupted'].map(key => [key, sum(workflows, w => w.interruptions[key])]));
  const markers = workflows.filter(w => w.interruptions.claudeMarkers !== null);
  const interruptTotal = sum(eligible, s => ['interrupted', 'replaced', 'other'].reduce((n, key) => n + number(s.workflow.interruptions[key]), number(s.workflow.interruptions.claudeMarkers ?? 0)));
  return {
    coverage: { sessions: all.length, supportedSessions: workflows.length, timedSessions: workflows.filter(w => number(w.time.observedSpanMilliseconds) > 0).length,
      humanSessions: human.length, contentRuleSessions: workflows.filter(w => w.coverage.contentRules).length, partialSessions: workflows.filter(w => w.coverage.timing === 'partial').length },
    autonomy: { humanTurns, turnsPerSession: human.length >= 5 ? humanTurns / human.length : null,
      toolRuns: histogram(human.map(w => w.toolRuns)), turnWallTime: histogram(workflows.map(w => w.turnWallTime)),
      recordedTurnDurations: sum(workflows, w => w.recordedTurnDurations), inferredTurnDurations: sum(workflows, w => w.inferredTurnDurations) },
    time: Object.fromEntries(['activeMilliseconds', 'waitingForHumanMilliseconds', 'unclassifiedMilliseconds'].map(key => [key, sum(workflows, w => w.time[key])])),
    interruptions: { ...interruptionCounts, claudeMarkers: markers.length ? sum(markers, w => w.interruptions.claudeMarkers) : null, eligibleHumanTurns, eligibleSessions: eligible.length, perHumanTurn: eligibleHumanTurns >= 5 ? interruptTotal / eligibleHumanTurns : null },
    steering, archetypes,
    abandonment: { flagged: workflows.filter(w => w.abandonment === 'flagged').length, eligible: workflows.filter(w => ['flagged', 'not-flagged'].includes(w.abandonment)).length,
      ongoing: workflows.filter(w => w.abandonment === 'ongoing').length, insufficientEvidence: workflows.filter(w => w.abandonment === 'insufficient-evidence').length },
    concurrency: concurrency(workflows),
    repositories: [...new Set(repositoryIds)].sort().map(repositoryId => {
      const selected = supported.filter(s => s.repositoryId === repositoryId), c = concurrency(selected.map(s => s.workflow));
      return { repositoryId, sessions: selected.length, peak: c.peak, effectiveParallelism: c.effectiveParallelism, activeSessionMilliseconds: c.activeSessionMilliseconds, wallClockActiveMilliseconds: c.wallClockActiveMilliseconds };
    }),
    patterns: patterns(workflows, asOfDay),
  };
}
export type LiveWorkflowProof = { scope: string; field: string; changedBefore: number; changedAfter: number; asOfBefore: string; asOfAfter: string;
  inventoryChanges?: { beforeRows: number; afterRows: number; addedMemberKeys: string[]; removedMemberKeys: string[] } };
export interface LiveInventoryEvidence { before: readonly [InventoryCensus, InventoryCensus]; after: readonly [InventoryCensus, InventoryCensus] }

function installedSkillCounts(actual: unknown, sessions: Row[]) {
  const members = new Map<string, Row>();
  for (const entry of rows(actual)) {
    if (!same(Object.keys(entry).sort(), ['name', 'observedInvocations', 'provider', 'repositoryId'].sort()) || !['claude', 'codex'].includes(entry.provider) || typeof entry.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(entry.name) || !(entry.repositoryId === null || typeof entry.repositoryId === 'string')) throw new Error('Invalid installed skill metadata.');
    const key = inventoryMemberKey(entry as any);
    if (members.has(key)) throw new Error('Duplicate installed skill metadata.');
    const expected = sessions.filter(s => s.provider === entry.provider && (entry.repositoryId === null || s.repositoryId === entry.repositoryId))
      .reduce((n, s) => n + integer(s.skills[entry.name] ?? 0), 0);
    if (integer(entry.observedInvocations) !== expected) throw new Error('Unproved skill invocation count.');
    members.set(key, entry);
  }
  return members;
}
const stableSkillCount = (entry: Row, sessions: Row[]) => sessions.filter(s => s.provider === entry.provider && (entry.repositoryId === null || s.repositoryId === entry.repositoryId))
  .reduce((n, s) => n + integer(s.skills[entry.name] ?? 0), 0);

/** Only verified workflow namespaces are replaced; all other snapshot fields keep
 * their original references and remain subject to the caller's strict comparison. */
export function proveLiveWorkflow(before: Row, after: Row, excluded: ReadonlySet<string>, inventory?: LiveInventoryEvidence) {
  const copy = (value: Row): Row & { repositories: Row[] } => ({ ...value, ...(value.workflow ? { workflow: { ...value.workflow } } : {}), repositories: rows(value.repositories).map(r => ({ ...r, ...(r.workflow ? { workflow: { ...r.workflow } } : {}) })) });
  const left = copy(before), right = copy(after), accepted: LiveWorkflowProof[] = [], failures: string[] = [];
  const prove = (a: Row, b: Row, oldRows: Row[], newRows: Row[], scope: string, oldIds: string[], newIds: string[]) => {
    if (!a.workflow && !b.workflow) return;
    if (!a.workflow || !b.workflow) { failures.push(`${scope}.workflow.presence`); return; }
    try {
      const oldDay = iso(timestamp(before.generatedAt)).slice(0, 10), newDay = iso(timestamp(after.generatedAt)).slice(0, 10);
      if (a.workflow.patterns.asOfDay !== oldDay || b.workflow.patterns.asOfDay !== newDay) { failures.push(`${scope}.workflow.patterns.asOfDay`); return; }
      const stableOld = oldRows.filter(s => !excluded.has(s.sessionKey)), stableNew = newRows.filter(s => !excluded.has(s.sessionKey));
      const signatures = (values: Row[]) => values.map(s => ({ key: s.sessionKey, repositoryId: s.repositoryId, provider: s.provider, status: s.transcript.status, workflow: s.workflow ?? null, skills: s.skills })).sort((x, y) => x.key.localeCompare(y.key));
      if (new Set(oldRows.map(s => s.sessionKey)).size !== oldRows.length || new Set(newRows.map(s => s.sessionKey)).size !== newRows.length || !same(signatures(stableOld), signatures(stableNew))) { failures.push(`${scope}.workflow.stableContributions`); return; }
      if (!same([...new Set(oldIds)].sort(), [...new Set(newIds)].sort())) { failures.push(`${scope}.workflow.repositoryScope`); return; }
      const expectedA = derive(oldRows, oldDay, oldIds), expectedB = derive(newRows, newDay, newIds);
      const stableA = derive(stableOld, oldDay, oldIds), stableB = derive(stableNew, oldDay, newIds);
      for (const field of Object.keys(expectedA) as Array<keyof typeof expectedA>) {
        if (!same(a.workflow[field], expectedA[field]) || !same(b.workflow[field], expectedB[field]) || !same(stableA[field], stableB[field])) { failures.push(`${scope}.workflow.${field}`); continue; }
        if (!same(a.workflow[field], b.workflow[field])) accepted.push({ scope, field: `workflow.${field}`, changedBefore: oldRows.length - stableOld.length, changedAfter: newRows.length - stableNew.length, asOfBefore: oldDay, asOfAfter: newDay });
        a.workflow[field] = stableA[field]; b.workflow[field] = stableA[field];
      }
      try {
        const installedA = installedSkillCounts(a.workflow.installedSkills, oldRows), installedB = installedSkillCounts(b.workflow.installedSkills, newRows);
        const removed = [...installedA.keys()].filter(key => !installedB.has(key)).sort(), added = [...installedB.keys()].filter(key => !installedA.has(key)).sort();
        let membershipProved = !removed.length && !added.length;
        if (inventory) {
          const oldInventory = verifyInventorySnapshot({ ...before, workflow: a.workflow, repositories: oldIds.map(id => ({ repository: { id } })) }, inventory.before);
          const newInventory = verifyInventorySnapshot({ ...after, workflow: b.workflow, repositories: newIds.map(id => ({ repository: { id } })) }, inventory.after);
          if (oldInventory.failures.length || newInventory.failures.length) { failures.push(`${scope}.workflow.installedSkills.inventoryEvidence`); return; }
          membershipProved = true;
        }
        const common = [...installedA.keys()].filter(key => installedB.has(key)).sort();
        const normalized = common.map(key => {
          const a = installedA.get(key)!, b = installedB.get(key)!;
          const oldCount = stableSkillCount(a, stableOld), newCount = stableSkillCount(b, stableNew);
          if (oldCount !== newCount) throw new Error('Changed stable skill contribution.');
          return { ...a, observedInvocations: oldCount };
        });
        // Without independent phase inventories, a membership change remains
        // untouched and strict even when its invocation count is exactly zero.
        if (membershipProved) {
          if (!same(a.workflow.installedSkills, b.workflow.installedSkills)) accepted.push({ scope, field: 'workflow.installedSkills', changedBefore: oldRows.length - stableOld.length, changedAfter: newRows.length - stableNew.length, asOfBefore: oldDay, asOfAfter: newDay,
            inventoryChanges: { beforeRows: installedA.size, afterRows: installedB.size, addedMemberKeys: added, removedMemberKeys: removed } });
          a.workflow.installedSkills = normalized; b.workflow.installedSkills = normalized;
        }
      } catch { failures.push(`${scope}.workflow.installedSkills.observedInvocations`); }
    } catch { failures.push(`${scope}.workflow.unavailable`); }
  };
  const oldRows = rows(before.sessions), newRows = rows(after.sessions);
  prove(left, right, oldRows, newRows, 'machine', left.repositories.map(r => r.repository.id), right.repositories.map(r => r.repository.id));
  const oldRepositories = new Map(left.repositories.map(r => [r.repository.id, r])), newRepositories = new Map(right.repositories.map(r => [r.repository.id, r]));
  for (const [id, a] of oldRepositories) {
    const b = newRepositories.get(id); if (!b) continue;
    const scope = `repository:${createHash('sha256').update(String(id)).digest('hex').slice(0, 12)}`;
    prove(a, b, oldRows.filter(s => s.repositoryId === id), newRows.filter(s => s.repositoryId === id), scope, [id], [id]);
  }
  return { left, right, accepted, failures: [...new Set(failures)].sort() };
}
