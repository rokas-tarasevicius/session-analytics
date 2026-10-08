import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileReference } from './reference.mjs';

test('reconciliation does not invent activity dates for summary-only tokens and value', () => {
  const session = {sessionKey:'abcdef012345',provider:'claude',createdAt:'2026-08-01T00:00:00.000Z',lastEventAt:null,
    costBasis:'provider-reported',cost:{totalUsd:2},tokens:{inputTokens:90,outputTokens:10},models:[],
    transcript:{startTimeKnown:true},spendByDay:{}};
  const summary = {sessions:1,totalInputTokens:90,outputTokens:10,estimatedSpendUsd:2,apiEquivalentSpendUsd:0,providerReportedSpendUsd:2};
  const snapshot={generatedAt:'2026-10-03T12:17:26.745Z',sessions:[session],summary,repositories:[{summary}],spendByModel:[]};
  const result=reconcileReference(snapshot);
  assert.equal(result.byStartMonth[0].month,'2026-08');
  assert.equal(result.byActivityMonth[0].month,'undated');
  assert.equal(result.byActivityMonth[0].inputTokens,90);
  assert.equal(result.byActivityMonth[0].outputTokens,10);
  assert.equal(result.byActivityMonth[0].providerReportedUsd,2);
  assert.equal(reconcileReference(snapshot,new Set(['abcdef012345'])).totals.sessions,0);
});

