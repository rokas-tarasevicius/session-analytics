import assert from 'node:assert/strict';
import test from 'node:test';
import { compareUnavailableCursorTime } from '../verify/other-providers/time-scope.ts';

test('Cursor run summaries and activity-only transcripts cannot acquire invented timed accounting',()=>{
  const sdk={sessionKey:'aaaaaaaaaaaa',spendByDay:{},metrics:{modelCalls:0},models:[{calls:0}],evidence:{fidelity:'summary',usageUnit:'run'}};
  assert.deepEqual(compareUnavailableCursorTime(sdk,'run-summary',{perRequestBillingIdentities:0}),[]);
  assert.ok(compareUnavailableCursorTime({...sdk,velocity:{buckets:[],undated:[]}},'run-summary',{perRequestBillingIdentities:0}).some(d=>d.field==='time.velocity'));
  assert.ok(compareUnavailableCursorTime({...sdk,spendByDay:{'2026-09-01':0}},'run-summary',{perRequestBillingIdentities:0}).some(d=>d.field==='time.spendByDay'));
  assert.ok(compareUnavailableCursorTime(sdk,'run-summary',{perRequestBillingIdentities:1}).some(d=>d.field==='time.raw.requestGranularity'));
  const transcript={...sdk,models:[],cost:{totalUsd:0},firstEventAt:null,lastEventAt:null,metrics:{modelCalls:0,durationMilliseconds:0,eventSpanMilliseconds:0},evidence:{tokens:'unavailable',timing:'file-mtime'}};
  const raw={timestampFields:0,usageFields:0,modelFields:0};assert.deepEqual(compareUnavailableCursorTime(transcript,'activity-only',raw),[]);
  assert.ok(compareUnavailableCursorTime({...transcript,firstEventAt:'2026-09-01T00:00:00Z'},'activity-only',raw).some(d=>d.field==='time.eventTiming'));
  assert.ok(compareUnavailableCursorTime(transcript,'activity-only',{...raw,usageFields:1}).some(d=>d.field==='time.raw.activityGranularity'));
});
