import assert from 'node:assert/strict';
import test from 'node:test';
import { proveLiveAggregates } from '../scripts/verify-real-live.ts';
import { aggregateSessions } from '../src/public/export-data.js';
import { summarizeOutcomes } from '../src/metrics/outcomes-summary.js';
import type { SessionAnalytics } from '../src/types.ts';

function session(key: string, n: number): SessionAnalytics {
  const usage = { inputTokens: n * 10, uncachedInputTokens: n * 5, cachedInputTokens: n * 5, cacheWriteInputTokens: 0,
    cacheWrite5mInputTokens: 0, cacheWrite1hInputTokens: 0, outputTokens: n, reasoningOutputTokens: 0, nonReasoningOutputTokens: n };
  const cost = { inputUsd: n, cachedInputUsd: 0, cacheWriteUsd: 0, outputUsd: 0, totalUsd: n, upperEstimateUsd: n };
  return { sessionKey: key, repositoryId: 'synthetic-repository', cost, tokens: usage, costBasis: 'api-list-price-equivalent',
    costComplete: true, pricedTokenCoverage: 1, executionKind: 'top-level', costByExecution: { topLevelUsd: n, subagentUsd: 0, unknownUsd: 0 },
    transcript: { status: 'ok', snapshotWhileWorking: key === 'live', warnings: [] },
    models: [{ model: 'synthetic-model', ...usage, ...cost, calls: n, priced: true, pricingCoverage: { pricedTokens: n * 11, eligibleTokens: n * 11 } }],
    metrics: { compactions: 0, toolCalls: n }, tools: { Read: n }, spendByDay: { '2026-10-03': n },
  } as unknown as SessionAnalytics;
}
function snapshot(rows: SessionAnalytics[]) {
  // Production aggregation creates the fixture; proof recomputes it independently.
  const aggregate = aggregateSessions(rows);
  return { ...aggregate, sessions: rows, summary: { ...aggregate.summary, repositories: 1, repositoriesWithSessions: 1, workingSnapshots: rows.filter(s => s.transcript.snapshotWhileWorking).length },
    repositories: [{ ...aggregate, repository: { id: 'synthetic-repository' } }], historyCoverage: { unknown: 1, profiles: [],
      months: [{ month: '2026-10', sessionEvidenceUsd: rows.reduce((n, s) => n + s.cost.totalUsd, 0), sessionsWithDatedValue: rows.length, recoveredMessageUsd: 0 }],
      undatedSessionValueUsd: 0, unassignedProfileTokens: 0 }, workflow: { unknown: 1 } };
}
test('exact live session contributions reconcile machine/repository money, tokens, coverage and ranked tables', () => {
  const before = snapshot([session('stable', 7), session('live', 2)]), after = snapshot([session('stable', 7), session('live', 5)]);
  const result = proveLiveAggregates(before, after, new Set(['live']));
  assert.deepEqual(result.failures, []);
  assert.equal(result.left.summary.estimatedSpendUsd, 7);
  assert.equal(result.right.summary.totalInputTokens, 70);
  assert.deepEqual(result.left.spendByModel, result.right.spendByModel);
  assert.deepEqual(result.left.repositories, result.right.repositories);
  assert.deepEqual(result.accepted.find(p => p.scope === 'machine' && p.field === 'summary.estimatedSpendUsd'),
    { scope: 'machine', field: 'summary.estimatedSpendUsd', before: 9, after: 12, changedBefore: 2, changedAfter: 5 });
  assert.equal(before.summary.estimatedSpendUsd, 9, 'proof never mutates saved snapshot');
});
test('live proof fails closed for arithmetic corruption, stable changes and missing operands', () => {
  const before = snapshot([session('stable', 7), session('live', 2)]), after = snapshot([session('stable', 7), session('live', 5)]);
  after.summary.estimatedSpendUsd += 0.01;
  let result = proveLiveAggregates(before, after, new Set(['live']));
  assert.ok(result.failures.includes('machine.summary.estimatedSpendUsd'));
  assert.equal(result.right.summary.estimatedSpendUsd, 12.01);
  result = proveLiveAggregates(before, snapshot([session('stable', 8), session('live', 5)]), new Set(['live']));
  assert.ok(result.failures.includes('machine.summary.totalInputTokens'));
  const missing = snapshot([session('stable', 7), session('live', 5)]);
  delete (missing.sessions[0]!.tokens as unknown as Record<string, number>)['inputTokens'];
  assert.ok(proveLiveAggregates(before, missing, new Set(['live'])).failures.includes('machine.unavailable'));
});
test('unproved metadata namespaces, unexpected table fields and no-exclusion differences remain visible', () => {
  const before = snapshot([session('stable', 7), session('live', 2)]), after = snapshot([session('stable', 7), session('live', 5)]);
  after.historyCoverage.unknown = 2; after.workflow.unknown = 2;
  const result = proveLiveAggregates(before, after, new Set(['live']));
  assert.notDeepEqual(result.left.historyCoverage, result.right.historyCoverage);
  assert.notDeepEqual(result.left.workflow, result.right.workflow);
  (after.spendByModel[0] as unknown as Record<string, unknown>)['unexpected'] = 1;
  assert.ok(proveLiveAggregates(before, after, new Set(['live'])).failures.includes('machine.spendByModel'));
  assert.equal(proveLiveAggregates(before, after, new Set()).accepted.length, 0);
});

test('live outcome ratios and history session values require exact independent operands', () => {
  const withOutcome = (key: string, n: number) => Object.assign(session(key, n), { outcomes: {
    editsObserved: true, links: [], operations: { commits: 0, pushes: 0, prsCreated: 0, prsEdited: 0, prsMerged: 0, prsClosed: 0 },
    lineCoverage: 'complete', linesAdded: n * 2, linesRemoved: n, truncated: false, enrichment: { git: 'off', github: 'off' },
  } }) as unknown as SessionAnalytics;
  const build = (n: number) => {
    const rows = [...Array.from({ length: 5 }, (_, i) => withOutcome(`stable-${i}`, 7)), withOutcome('live', n)];
    const result = snapshot(rows), outcomes = summarizeOutcomes(rows);
    Object.assign(result, { outcomes, historyCoverage: { profiles: [], months: [{ month: '2026-10', sessionEvidenceUsd: 35 + n, sessionsWithDatedValue: 6, recoveredMessageUsd: 0,
      unattributedEstimateUsd: 4, possibleOverlapTokens: 10 }], undatedSessionValueUsd: 0, unassignedProfileTokens: 0 } });
    Object.assign(result.repositories[0]!, { outcomes });
    return result;
  };
  const before = build(2), after = build(5);
  const result = proveLiveAggregates(before, after, new Set(['live']));
  assert.deepEqual(result.failures, []);
  assert.equal(result.left.outcomes.linesPerApiDollar.denominator, 35);
  assert.equal(result.left.outcomes.linesPerApiDollar.numerator, 105);
  assert.equal(result.left.historyCoverage.months[0].sessionEvidenceUsd, 35);
  assert.equal(result.left.historyCoverage.months[0].unattributedEstimateUsd, 4, 'external statistics estimate is preserved');
  const broken = build(5) as unknown as Record<string, any>;
  broken.outcomes.linesPerApiDollar.denominator += 1;
  broken.historyCoverage.months[0].sessionEvidenceUsd += 1;
  const rejected = proveLiveAggregates(before, broken, new Set(['live']));
  assert.ok(rejected.failures.includes('machine.outcomes'));
  assert.ok(rejected.failures.includes('historyCoverage.months.sessionEvidenceUsd'));
});
