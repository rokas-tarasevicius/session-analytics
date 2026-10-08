import assert from 'node:assert/strict';
import test from 'node:test';
import { harness, sample } from './aggregation-ui-harness.ts';

test('AGG-003: Costs discloses provider-reported value without model attribution',async()=>{
 const h=await harness([sample()]);h.run('renderCosts(activeView())');
 const text=h.document.querySelector('#cost-models')!.textContent;
 // Receipt says $10, but only $6 is attributable to a model. The other $4 must stay visible.
 assert.match(text,/\$4\.00[^]*No model evidence|No model evidence[^]*\$4\.00/);
});
