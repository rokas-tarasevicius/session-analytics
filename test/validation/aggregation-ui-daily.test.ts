import assert from 'node:assert/strict';
import test from 'node:test';
import { harness, sample } from './aggregation-ui-harness.ts';

test('AGG-004: Summary daily chart uses the same declared local activity ledger as Velocity',async()=>{
 const s=sample();s.costBasis='api-list-price-equivalent';s.cost.totalUsd=10;s.spendByDay={'2026-09-30':10};
 s.velocity={dimensions:[{agent:'claude-cli',model:'model-synthetic',executionKind:'top-level',effort:'unknown'}],buckets:[['2026-10-01',0,0,[10,100,100,0,0,20,0,1,0,1,120,0,100,0]]],undated:[]};
 const h=await harness([s]);
 h.run(`elements.windowStart.value='2026-10-01';elements.windowEnd.value='2026-10-01';`);
 const values=h.run('dailyProviderSpend(fixture.sessions)') as Array<{claude:number}>;
 assert.equal(values.reduce((sum,d)=>sum+d.claude,0),10);
});

test('AGG-005: spend KPI sparkline discloses its dated subset rather than implying total-price reconciliation',async()=>{
 const s=sample();s.cost.totalUsd=10;s.spendByDay={};
 const h=await harness([s]);
 h.run(`renderLine=()=>{};renderDonut=()=>{};renderProviderEvidence=()=>{};renderSummary(activeView());`);
 const label=h.document.querySelector('#metric-spend-spark')!.getAttribute('aria-label')??'';
 // A reported $10 receipt has no daily attribution; a flat '$0 total' chart needs a basis warning.
 assert.match(label,/API-equivalent|dated only|undated|no dated/i);
});
