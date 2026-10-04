import assert from 'node:assert/strict';
import test from 'node:test';
import { harness, sample } from './aggregation-ui-harness.ts';

test('AGG-006: Activity never treats an explicitly unknown start as a recorded session start',async()=>{
 const s=sample();s.transcript.startTimeKnown=false;
 const h=await harness([s]);h.run('renderActivity(activeView())');
 assert.equal(h.document.querySelectorAll('.heat-cell').reduce((sum,n)=>sum+Number(n.dataset['value']),0),0);
 assert.match(h.document.querySelector('#activity-evidence')!.textContent,/0\/1/);
});
