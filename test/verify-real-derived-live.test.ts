import assert from 'node:assert/strict';
import test from 'node:test';
import { boundContextDetail } from '../src/metrics/context-detail.ts';
import { calibrateRecovery } from '../src/metrics/recovery-calibration.ts';
import { proveContextCurves } from '../scripts/verify-real-context.ts';
import { proveCalibration, sameCalibration, calibrationSummary } from '../scripts/verify-real-calibration.ts';
import { compareStableSnapshots } from '../scripts/verify-real.ts';
import type { MachineAnalytics, SessionAnalytics } from '../src/types.ts';

test('source-unchanged context samples require exact pre-budget inputs and both independent budget allocations', () => {
  const session = (sessionKey: string, n: number) => ({ sessionKey, limitsCache: { context: { eligibleRequests: n, requests: n, curveSampled: false,
    curve: Array.from({ length: n }, (_, i) => ({ request: i + 1, timestamp: '2026-10-01T12:00:00Z', executionKind: 'top-level', inputTokens: i + 1, windowTokens: 100, fill: (i + 1) / 100 })) } } });
  const before = { sessions: [session('live', 1), session('stable-a', 8), session('stable-b', 8)] };
  const evidence = { source: 'fresh-index-before-global-curve-budget', capturedAt: '2026-10-01T13:00:00Z', rows: structuredClone(before.sessions).map(s => ({ sessionKey: s.sessionKey, context: s.limitsCache.context })) };
  const after = { sessions: [session('live', 5), session('stable-a', 8), session('stable-b', 8)] };
  for (const snapshot of [before, after]) boundContextDetail(snapshot.sessions as unknown as SessionAnalytics[], 12);
  const excluded = new Set(['live']);
  const proof = proveContextCurves(before, after, excluded, evidence, 12);
  assert.equal(proof.length, 2);
  const compare = (right: typeof after, accepted = proof) => compareStableSnapshots(before as unknown as MachineAnalytics, right as unknown as MachineAnalytics, excluded, new Set(accepted.map(p=>p.sessionKey)));
  assert.deepEqual(compare(after), []);
  assert.equal(proveContextCurves(before, after, new Set(), evidence, 12).length, 0);
  const broken = structuredClone(after); broken.sessions[1]!.limitsCache.context.curve[1]!.inputTokens++;
  assert.ok(compare(broken, proveContextCurves(before, broken, excluded, evidence, 12)).length > 0, 'A fabricated point is never waived');
  const counters = structuredClone(after); counters.sessions[1]!.limitsCache.context.requests++;
  assert.ok(compare(counters, proveContextCurves(before, counters, excluded, evidence, 12)).length > 0, 'Counters remain strict');
});

test('live calibration proof recomputes each cohort and every quantile before removing the same changed identities', () => {
  const sessions = Array.from({ length: 6 }, (_, i) => ({ sessionKey: String(i), provider: 'claude', costBasis: 'api-list-price-equivalent', pricedTokenCoverage: 1,
    cost: { totalUsd: 10 }, transcript: { files: 1, completeness: 'complete', liveness: 'inactive', snapshotWhileWorking: false } } as SessionAnalytics));
  const pairs = sessions.map((s, i) => ({ sessionKey: s.sessionKey, valueUsd: 8 + i, receiptFloorApplied: i > 1 }));
  const make = (rows: SessionAnalytics[]) => ({ sessions: rows, historyCoverage: { recoveryCalibration: calibrateRecovery(rows, pairs.map(p=>({sessionKey:p.sessionKey,cost:{totalUsd:p.valueUsd},conductor:{reconciliation:{receiptFloorApplied:p.receiptFloorApplied}}}))) } });
  const before = make(sessions), live = structuredClone(sessions); live[5]!.transcript.liveness = 'active';
  const after = make(live), excluded = new Set(['5']);
  assert.ok(sameCalibration(before.historyCoverage.recoveryCalibration, calibrationSummary(before, pairs)));
  assert.ok(proveCalibration(before, after, pairs, pairs, excluded));
  assert.equal(proveCalibration(before, after, pairs, pairs, new Set()), null);
  const broken = structuredClone(after); broken.historyCoverage.recoveryCalibration.p90ValueRatio! += .01;
  assert.equal(proveCalibration(before, broken, pairs, pairs, excluded), null, 'Unexplained quantile changes fail');
  assert.throws(() => calibrationSummary(before, [...pairs, pairs[0]!]));
});
