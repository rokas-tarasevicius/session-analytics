import assert from 'node:assert/strict';
import test from 'node:test';
import { proveLiveWorkflow } from '../scripts/verify-real-live-workflow.ts';
import { summarizeWorkflow } from '../src/public/workflow-data.js';
import type { SessionAnalytics } from '../src/types.ts';

type Row = Record<string, any>;
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 2, 23, 59) + minutes * 60_000).toISOString();
function session(key: string, minutes: number, repositoryId = 'synthetic-repository'): Row {
  const histogram = (value: number) => ({ bins: [{ value, count: 1 }], samples: 1, p50: value, p95: value, max: value });
  return { sessionKey: key, repositoryId, provider: 'codex', skills: {}, transcript: { status: 'ok' }, workflow: {
    schemaVersion: 1, scope: 'primary-transcript', ending: 'terminal',
    coverage: { timing: 'observed', humanTurns: 'observed', contentRules: false, timestampedEvents: 4, untimedEvents: 0, droppedEvents: 0, malformedRecords: 0, projectionErrors: 0 },
    humanTurns: minutes, toolCalls: minutes * 2, toolRuns: histogram(minutes * 2), turnWallTime: histogram(minutes * 60_000), recordedTurnDurations: 1, inferredTurnDurations: 0,
    time: { activeMilliseconds: minutes * 60_000, waitingForHumanMilliseconds: 0, unclassifiedMilliseconds: 0, observedSpanMilliseconds: minutes * 60_000,
      idleThresholdMilliseconds: 300_000, waitingCapMilliseconds: 1_800_000, activeSpans: [{ start: at(0), end: at(minutes) }] },
    interruptions: { interrupted: 0, replaced: 0, other: 0, subagentInterrupted: 0, claudeMarkers: null },
    steering: { midTurnHumanTurns: 0, planEntries: 0, planItems: 0, queueOperations: { enqueue: minutes, dequeue: minutes, remove: 0, other: 0 }, queueReasons: { prompt: 0, interrupt: 0, completion: 0, cancellation: 0, other: minutes, unspecified: 0 } },
    archetype: minutes > 2 ? 'deep' : 'quick', abandonment: minutes > 2 ? 'ongoing' : 'not-flagged',
    mix: [], commands: [], unrecognizedCommands: 0, commandHistoryAvailable: false,
    valueByHour: [{ hour: '2026-10-03T00:00:00.000Z', usd: minutes }], pricedRequests: minutes, timestampedPricedRequests: minutes,
  } };
}
function snapshot(sessions: Row[], generatedAt = '2026-10-03T12:00:00.000Z'): Row {
  const ids = [...new Set(sessions.map(s => s.repositoryId))];
  // Production builds fixtures; the proof has no production imports and derives
  // pooled histograms, interval membership and UTC hour allocations independently.
  return { generatedAt, sessions, workflow: summarizeWorkflow(sessions as SessionAnalytics[], undefined, generatedAt, ids),
    repositories: ids.map(id => ({ repository: { id }, workflow: summarizeWorkflow(sessions.filter(s => s.repositoryId === id) as SessionAnalytics[], undefined, generatedAt, [id]) })),
    untouched: { sentinel: 1 },
  };
}
function pair() {
  const stable = Array.from({ length: 5 }, (_, n) => session(`stable-${n}`, 2, n === 4 ? 'second-repository' : 'synthetic-repository'));
  return { before: snapshot([...stable, session('live', 1)]), after: snapshot([...structuredClone(stable), session('live', 4)]) };
}
test('independent workflow proof pools bins and reconciles UTC overlaps and live repository contributions', () => {
  const { before, after } = pair(), result = proveLiveWorkflow(before, after, new Set(['live']));
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.left.workflow, result.right.workflow);
  assert.deepEqual(result.left.repositories, result.right.repositories);
  assert.equal(result.left.workflow.autonomy.humanTurns, 10);
  assert.equal(result.left.workflow.autonomy.turnsPerSession, 2);
  assert.deepEqual(result.left.workflow.autonomy.toolRuns, { bins: [{ value: 4, count: 5 }], samples: 5, p50: 4, p95: 4, max: 4 });
  assert.deepEqual(result.left.workflow.concurrency, {
    peak: 5, activeSessionMilliseconds: 600_000, wallClockActiveMilliseconds: 120_000, effectiveParallelism: 5, eligibleSessions: 5,
    timeline: [{ start: at(0), end: at(2), sessions: 5 }],
    daily: [
      { day: '2026-10-02', peak: 5, activeSessionMilliseconds: 300_000, wallClockActiveMilliseconds: 60_000 },
      { day: '2026-10-03', peak: 5, activeSessionMilliseconds: 300_000, wallClockActiveMilliseconds: 60_000 },
    ],
  });
  assert.equal(result.left.workflow.patterns.cells[5 * 24 + 23].activeMilliseconds, 300_000);
  assert.equal(result.left.workflow.patterns.cells[6 * 24].activeMilliseconds, 300_000);
  assert.equal(result.left.workflow.patterns.cells[6 * 24].apiEquivalentUsd, 10);
  assert.equal(result.left.workflow.patterns.currentStreakDays, 2);
  assert.ok(result.accepted.some(p => p.scope === 'machine' && p.field === 'workflow.concurrency'));
  assert.ok(result.accepted.some(p => p.scope.startsWith('repository:') && p.field === 'workflow.patterns'));
  assert.equal(before.workflow.autonomy.humanTurns, 11, 'saved snapshot remains unchanged');
});
test('workflow proof rejects numerical corruption, missing operands, and cancelling stable changes', () => {
  let { before, after } = pair();
  after.workflow.concurrency.timeline[0].sessions++;
  let result = proveLiveWorkflow(before, after, new Set(['live']));
  assert.ok(result.failures.includes('machine.workflow.concurrency'));
  assert.notDeepEqual(result.left.workflow.concurrency, result.right.workflow.concurrency);
  ({ before, after } = pair());
  after.sessions[0].workflow.humanTurns++;
  after.sessions[1].workflow.humanTurns--;
  result = proveLiveWorkflow(before, after, new Set(['live']));
  assert.ok(result.failures.includes('machine.workflow.stableContributions'));
  ({ before, after } = pair());
  delete after.sessions.at(-1).workflow.steering.queueReasons.other;
  assert.ok(proveLiveWorkflow(before, after, new Set(['live'])).failures.includes('machine.workflow.unavailable'));
  ({ before, after } = pair());
  after.workflow.autonomy.humanTurns = NaN;
  assert.ok(proveLiveWorkflow(before, after, new Set(['live'])).failures.includes('machine.workflow.autonomy'));
});
test('asOf transitions are derived from snapshot dates; future dates and unproved namespaces stay strict', () => {
  const { before } = pair();
  const after = snapshot(structuredClone(before.sessions), '2026-10-05T00:00:00.000Z');
  let result = proveLiveWorkflow(before, after, new Set());
  assert.deepEqual(result.failures, []);
  assert.equal(before.workflow.patterns.currentStreakDays, 2);
  assert.equal(after.workflow.patterns.currentStreakDays, 0);
  assert.deepEqual(result.left.workflow.patterns, result.right.workflow.patterns);
  assert.deepEqual(result.accepted.map(p => p.field), ['workflow.patterns', 'workflow.patterns', 'workflow.patterns']);
  after.workflow.patterns.asOfDay = '2099-01-01';
  assert.ok(proveLiveWorkflow(before, after, new Set()).failures.includes('machine.workflow.patterns.asOfDay'));
  const live = pair();
  live.after.workflow.inventory.directoriesRead++;
  live.after.workflow.unproved = 2;
  live.after.workflow.time.unexpected = 1;
  result = proveLiveWorkflow(live.before, live.after, new Set(['live']));
  assert.notDeepEqual(result.left.workflow.inventory, result.right.workflow.inventory);
  assert.equal(result.right.workflow.unproved, 2);
  assert.ok(result.failures.includes('machine.workflow.time'));
  assert.notDeepEqual(result.left.workflow.time, result.right.workflow.time);
});
test('half-open endpoints avoid false overlap and the parallelism denominator guard stays null', () => {
  const one = session('one', 1), two = session('two', 1);
  two.workflow.time.activeSpans = [{ start: at(1), end: at(2) }];
  const before = snapshot([one, two]), after = snapshot(structuredClone([one, two]));
  const result = proveLiveWorkflow(before, after, new Set());
  assert.deepEqual(result.failures, []);
  assert.equal(result.left.workflow.concurrency.peak, 1);
  assert.equal(result.left.workflow.concurrency.effectiveParallelism, 1);
  assert.deepEqual(result.left.workflow.concurrency.timeline, [{ start: at(0), end: at(2), sessions: 1 }]);
  const short = session('short', 1);
  short.workflow.time.activeSpans = [{ start: at(0), end: new Date(Date.parse(at(0)) + 30_000).toISOString() }];
  short.workflow.time.activeMilliseconds = 30_000;
  const a = snapshot([short]), b = snapshot(structuredClone([short]));
  const proof = proveLiveWorkflow(a, b, new Set());
  assert.deepEqual(proof.failures, []);
  assert.equal(proof.left.workflow.concurrency.effectiveParallelism, null);
});

test('installed skill counts are independent of workflow support and inventory membership stays strict without capture', () => {
  const { before, after } = pair();
  for (const [snapshot, n] of [[before, 2], [after, 7]] as const) {
    snapshot.sessions.at(-1).skills = { 'synthetic-skill': n };
    snapshot.workflow.installedSkills = [{ name: 'synthetic-skill', provider: 'codex', repositoryId: null, observedInvocations: n }];
  }
  const result = proveLiveWorkflow(before, after, new Set(['live']));
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.left.workflow.installedSkills, result.right.workflow.installedSkills);
  assert.equal(result.left.workflow.installedSkills[0].observedInvocations, 0);
  assert.ok(result.accepted.some(p => p.field === 'workflow.installedSkills'));
  after.workflow.installedSkills.push({ name: 'new-installation', provider: 'codex', repositoryId: null, observedInvocations: 0 });
  const membership = proveLiveWorkflow(before, after, new Set(['live']));
  assert.deepEqual(membership.failures, []);
  assert.notDeepEqual(membership.left.workflow.installedSkills, membership.right.workflow.installedSkills);
  after.workflow.installedSkills[0].observedInvocations++;
  assert.ok(proveLiveWorkflow(before, after, new Set(['live'])).failures.includes('machine.workflow.installedSkills.observedInvocations'));
});

test('fresh phase inventory captures prove an added zero-use installation but never unknown metadata', async () => {
  const { mkdir, mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { captureSupportedInventory } = await import('../scripts/verify-real-inventory.ts');
  const root = await mkdtemp(join(tmpdir(), 'workflow-inventory-phase-'));
  try {
    const path = join(root, 'skills'); await mkdir(path);
    const roots = [{ path, provider: 'codex' as const, repositoryId: null }];
    const preFull = await captureSupportedInventory(roots);
    const before = snapshot([session('stable', 2)], new Date().toISOString());
    const postFull = await captureSupportedInventory(roots);
    await mkdir(join(path, 'new-installation')); await writeFile(join(path, 'new-installation', 'SKILL.md'), 'PRIVATE_BODY');
    const prePhase = await captureSupportedInventory(roots);
    const after = snapshot(structuredClone(before.sessions), new Date().toISOString());
    const installed = [{ name: 'new-installation', provider: 'codex', repositoryId: null, observedInvocations: 0 }];
    after.workflow.installedSkills = installed;
    after.repositories[0].workflow.installedSkills = installed;
    const postPhase = await captureSupportedInventory(roots);
    const evidence = { before: [preFull, postFull] as const, after: [prePhase, postPhase] as const };
    const result = proveLiveWorkflow(before, after, new Set(), evidence);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.left.workflow, result.right.workflow);
    const proof = result.accepted.find(p => p.scope === 'machine' && p.field === 'workflow.installedSkills')!;
    assert.equal(proof.inventoryChanges!.beforeRows, 0);
    assert.equal(proof.inventoryChanges!.afterRows, 1);
    assert.equal(proof.inventoryChanges!.addedMemberKeys.length, 1);
    assert.deepEqual(proof.inventoryChanges!.removedMemberKeys, []);
    const corrupted = structuredClone(after);
    corrupted.workflow.installedSkills[0].unexpected = 1;
    const rejected = proveLiveWorkflow(before, corrupted, new Set(), evidence);
    assert.ok(rejected.failures.includes('machine.workflow.installedSkills.observedInvocations'));
    assert.equal(rejected.right.workflow.installedSkills[0].unexpected, 1);
    const unobserved = structuredClone(after);
    unobserved.workflow.installedSkills[0].name = 'unobserved';
    assert.ok(proveLiveWorkflow(before, unobserved, new Set(), evidence).failures.includes('machine.workflow.installedSkills.inventoryEvidence'));
    after.workflow.inventory.directoriesRead++;
    const strict = proveLiveWorkflow(before, after, new Set(), evidence);
    assert.notDeepEqual(strict.left.workflow.inventory, strict.right.workflow.inventory, 'operational inventory counters are never waived');
  } finally { await rm(root, { recursive: true, force: true }); }
});
