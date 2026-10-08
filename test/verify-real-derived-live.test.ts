import assert from 'node:assert/strict';
import test from 'node:test';
import { calibrateRecovery } from '../src/metrics/recovery-calibration.ts';
import { proveCalibration, sameCalibration, calibrationSummary } from '../scripts/verify-real-calibration.ts';
import { compareStableSnapshots } from '../scripts/verify-real.ts';
import type { MachineAnalytics, SessionAnalytics } from '../src/types.ts';

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
