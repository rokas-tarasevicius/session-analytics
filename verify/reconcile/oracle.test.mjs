import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeSeries, collectQuota } from './quota.mjs';
import { reconcileReference } from './reference.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('quota oracle excludes future and malformed points without summing percentages', () => {
  const result = summarizeSeries([
    {at:'2026-08-31T23:59:00.000Z',value:90,reset:'2026-09-01'},
    {at:'2026-09-01T00:01:00.000Z',value:10,reset:'2026-09-02'},
    {at:'2026-10-04T00:00:00.000Z',value:100},
    {at:null,value:3},
  ]);
  assert.equal(result.samples,2);
  assert.equal(result.excludedAfterCutoff,1);
  assert.equal(result.invalidSamples,1);
  assert.equal(result.latestValue,10);
  assert.equal(result.decreasesWithinWindow,0);
  assert.deepEqual(result.months.map(m=>[m.month,m.samples,m.min,m.max]),[
    ['2026-08',1,90,90],['2026-09',1,10,10],
  ]);
});

test('reconciliation does not invent activity dates for summary-only tokens and value', () => {
  const session = {sessionKey:'abcdef012345',provider:'claude',createdAt:'2026-08-01T00:00:00.000Z',lastEventAt:null,
    costBasis:'provider-reported',cost:{totalUsd:2},tokens:{inputTokens:90,outputTokens:10},models:[],
    transcript:{startTimeKnown:true},spendByDay:{}};
  const summary = {sessions:1,totalInputTokens:90,outputTokens:10,estimatedSpendUsd:2,apiEquivalentSpendUsd:0,providerReportedSpendUsd:2};
  const snapshot={generatedAt:'2026-10-03T12:17:26.745Z',sessions:[session],summary,repositories:[{summary}],spendByModel:[],limitsCache:{profiles:[]}};
  const result=reconcileReference(snapshot);
  assert.equal(result.byStartMonth[0].month,'2026-08');
  assert.equal(result.byActivityMonth[0].month,'undated');
  assert.equal(result.byActivityMonth[0].inputTokens,90);
  assert.equal(result.byActivityMonth[0].outputTokens,10);
  assert.equal(result.byActivityMonth[0].providerReportedUsd,2);
  assert.equal(reconcileReference(snapshot,new Set(['abcdef012345'])).totals.sessions,0);
});

test('quota oracle hashes account identities and excludes arbitrary content', async () => {
  const root = await mkdtemp(join(tmpdir(),'reconcile-quota-'));
  const sentinel = 'PRIVATE-RECONCILE-ACCOUNT-SENTINEL';
  try {
    const desktop = join(root,'Library/Application Support/Claude');
    const bar = join(root,'Library/Application Support/com.steipete.codexbar/history');
    await mkdir(desktop,{recursive:true}); await mkdir(bar,{recursive:true});
    await writeFile(join(desktop,'plan-usage-history.json'),JSON.stringify({samples:[{
      t:Date.parse('2026-09-01T00:00:00Z'),org:sentinel,u:{fh:20,sd:30,xu:sentinel},content:sentinel,
    }]}));
    await writeFile(join(bar,'claude.json'),JSON.stringify({accounts:{[sentinel]:[{
      windowMinutes:300,name:sentinel,entries:[{capturedAt:'2026-09-01T00:00:00Z',usedPercent:20,resetsAt:'2026-09-01T05:00:00Z',content:sentinel}],
    }]}}));
    const result = await collectQuota(root);
    assert.equal(result.desktop.accounts[0].fields.fh.samples,1);
    assert.equal(result.codexbar[0].samples,1);
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE-RECONCILE|reconcile-quota-/);
  } finally { await rm(root,{recursive:true,force:true}); }
});
