import assert from 'node:assert/strict';
import test from 'node:test';
import { proveLiveLimits, quotaWindowProof } from '../scripts/verify-real-live-limits.ts';
const policy={freshnessMinutes:15,maximumObservationGapMinutes:15,minimumObservedMinutes:5,minimumRequests:3};
const point=(minute:number,used:number)=>({timestamp:`2026-10-03T10:${String(minute).padStart(2,'0')}:00.000Z`,usedPercent:used,resetsAt:'2026-10-03T11:00:00.000Z',status:null,source:'codex-transcript',usingOverage:null});
const rows=[point(0,80),point(5,90),point(10,95)];
function snapshot(live=false){
  const observations=live?[...rows,point(15,98)]:rows,latest=observations.at(-1)!;
  const value=live?14:10,tokens=live?1400:1000;
  const window={key:'primary',label:'Codex primary',windowMinutes:300,duplicatesDiscarded:0,observations:observations.length,historyLimited:false,timelineSampled:false,timeline:observations,latest,latestNumeric:latest,headroomExpiresAt:live?'2026-10-03T10:30:00.000Z':'2026-10-03T10:25:00.000Z',stale:false,headroomPercent:live?2:5,timeToLimitMinutes:live?2.5:10/3,observedMinutes:live?15:10,above90Minutes:live?10:5,shareAbove90:live?2/3:.5};
  const credits={observedAt:latest.timestamp,hasCredits:true,unlimited:false,balance:100};
  return {generatedAt:live?'2026-10-03T10:16:00.000Z':'2026-10-03T10:12:00.000Z',sessions:[{sessionKey:'live',costBasis:'api-list-price-equivalent',limitsCache:{profileKey:'profile-synthetic',quotaEvidence:[{profileKey:'profile-synthetic',planType:'pro',planObservedAt:latest.timestamp,credits,windows:[{key:'primary',historyLimited:false,observations}]}],buckets:[{day:'2026-10-03',apiEquivalentUsd:value,observedTokens:tokens,pricedTokens:tokens}]}}],limitsCache:{policy,profiles:[{key:'profile-synthetic',planType:'pro',planObservedAt:latest.timestamp,credits,windows:[window],label:'Synthetic profile'}],subscriptions:[{profileKey:'profile-synthetic',month:'2026-10',apiEquivalentUsd:value,monthlyPriceUsd:null,leverage:null,observedTokens:tokens,pricedTokens:tokens,pricingCoverage:1,activeDays:1,partialMonth:true,scope:'all-repositories'}],warnings:[]}};
}
test('quota proof independently computes exposure, expiry and projected time from exact observations',()=>{
  const expected=quotaWindowProof(rows,{timeline:rows},policy,'2026-10-03T10:12:00Z');
  assert.equal(expected.observedMinutes,10);assert.equal(expected.above90Minutes,5);assert.equal(expected.shareAbove90,.5);assert.equal(expected.headroomPercent,5);assert.equal(expected.timeToLimitMinutes,10/3);
  assert.equal(expected.headroomExpiresAt,'2026-10-03T10:25:00.000Z');
  const expired=quotaWindowProof(rows,{timeline:rows},policy,'2026-10-03T10:25:00Z');assert.equal(expired.stale,true);assert.equal(expired.headroomPercent,null);assert.equal(expired.timeToLimitMinutes,null);
  const future=quotaWindowProof(rows,{timeline:rows},policy,'2026-10-03T10:06:00Z');assert.equal(future.observedMinutes,5);assert.equal(future.shareAbove90,null);assert.equal(future.headroomPercent,null);
});
test('quota proof preserves quiet gaps and clips exposure at the previous reset',()=>{
  const clipped=[{...point(0,95),resetsAt:'2026-10-03T10:02:00.000Z'},point(5,96),point(30,99)];
  const result=quotaWindowProof(clipped,{timeline:clipped},policy,'2026-10-03T10:31:00Z');assert.equal(result.observedMinutes,2);assert.equal(result.above90Minutes,2);assert.equal(result.shareAbove90,null);assert.equal(result.timeToLimitMinutes,null);
});
test('precisely identified live sessions explain quota observations and subscription amounts',()=>{
  const a=snapshot(),b=snapshot(true),original=structuredClone(b),result=proveLiveLimits(a,b,new Set(['live']));
  assert.deepEqual(result.failures,[]);assert.equal(result.accepted.length,4);assert.deepEqual(result.left.limitsCache,result.right.limitsCache);assert.deepEqual(b,original);
  const denied=proveLiveLimits(a,b,new Set(['unrelated']));assert.ok(denied.failures.some(f=>f.endsWith('.unavailable')));assert.ok(denied.failures.includes('limitsCache.subscriptions'));
});
test('live source changes do not excuse invented aggregate usage or metadata',()=>{
  const a=snapshot(),b=snapshot(true);b.limitsCache.profiles[0]!.windows[0]!.observedMinutes++;
  let result=proveLiveLimits(a,b,new Set(['live']));assert.ok(result.failures.some(f=>f.includes('window:primary')));assert.notDeepEqual(result.left.limitsCache.profiles,result.right.limitsCache.profiles);
  const c=snapshot(true);c.limitsCache.profiles[0]!.label='Changed without evidence';result=proveLiveLimits(a,c,new Set(['live']));assert.notEqual(result.left.limitsCache.profiles[0].label,result.right.limitsCache.profiles[0].label);
  const d=snapshot(true);d.limitsCache.subscriptions[0]!.observedTokens++;result=proveLiveLimits(a,d,new Set(['live']));assert.ok(result.failures.includes('limitsCache.subscriptions'));
});
test('timeline proof rejects points absent from raw evidence, including sampled replacements',()=>{
  assert.throws(()=>quotaWindowProof(rows,{timeline:[rows[0],point(5,91),rows[2]]},policy,'2026-10-03T10:12:00Z'));
  const many=Array.from({length:481},(_,i)=>({...point(0,50),timestamp:new Date(Date.parse('2026-10-03T00:00:00Z')+i*1000).toISOString()}));
  const timeline=Array.from({length:480},(_,i)=>many[Math.round(i*480/479)]);
  assert.equal(quotaWindowProof(many,{timeline},policy,'2026-10-03T00:08:01Z').timelineSampled,true);
  timeline[20]={...timeline[20]!,usedPercent:51};assert.throws(()=>quotaWindowProof(many,{timeline},policy,'2026-10-03T00:08:01Z'));
});
