import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { normalizeTimestamp } from '../../src/public/timestamps.js';
import { daysBetween, dailySpendSeries } from '../../src/public/view-model.js';

function observedRange(sessions: unknown[]) {
 const source=fs.readFileSync(new URL('../../src/public/app.js',import.meta.url),'utf8');
 const begin=source.indexOf('function observedRange(');
 const end=source.indexOf('\nfunction ',begin+1);
 return vm.runInNewContext(`${source.slice(begin,end)}\nobservedRange()`,{snapshot:{sessions},normalizeTimestamp});
}

test('time-range: unknown start placeholders cannot erase dated charts through the 3660-day cap',()=>{
 const sessions=[
  {createdAt:'2000-01-01T00:00:00Z',transcript:{startTimeKnown:false},spendByDay:{'2026-09-01':7}},
  {createdAt:'2026-09-02T12:00:00Z',transcript:{startTimeKnown:true},spendByDay:{'2026-09-02':3}},
 ];
 const bounds=observedRange(sessions);
 const days=daysBetween(bounds.minimum,bounds.maximum);
 assert.equal(dailySpendSeries(sessions,days).reduce((n,v)=>n+v,0),10,'All dated value remains visible despite unknown starts');
 assert.equal(bounds.minimum,'2026-09-01');
});

test('time-range: file modification dates cannot widen observed activity history',()=>{
 const bounds=observedRange([
  {createdAt:'2099-01-01T00:00:00Z',evidence:{timing:'file-mtime'},spendByDay:{}},
  {createdAt:'2026-09-01T00:30:00+01:00',spendByDay:{'2026-09-01':2}},
 ]);
 assert.equal(bounds.minimum,'2026-08-31','Known starts use their normalized UTC dates');
 assert.equal(bounds.maximum,'2026-09-01','File timestamps are not activity evidence');
});

test('time-range: unknown starts retain independently dated velocity and compaction evidence',()=>{
 const bounds=observedRange([
  {createdAt:'2000-01-01T00:00:00Z',transcript:{startTimeKnown:false},spendByDay:{},velocity:{buckets:[['2026-08-31',1,0,[]]]},limitsCache:{compactions:[{timestamp:'2026-09-02T12:00:00Z'}]}},
 ]);
 assert.equal(bounds.minimum,'2026-08-31');
 assert.equal(bounds.maximum,'2026-09-02');
});
