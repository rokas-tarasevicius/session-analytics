import assert from 'node:assert/strict';
import test from 'node:test';
import { harness, sample, withLedger } from './aggregation-ui-harness.ts';

test('AGG-003: Costs discloses provider-reported value without model attribution',async()=>{
 // Receipt says $10, but only $6 is attributable to a model. The other $4 must stay visible, on the receipt's
 // session-dated ledger cells like every other Costs value.
 const h=await harness([withLedger(sample(),[['model-synthetic',6],['<unknown>',4]],{sessionDated:true})]);h.run('renderCosts(activeView())');
 const text=h.document.querySelector('#cost-models')!.textContent;
 assert.match(text,/\$4\.00[^]*No model evidence|No model evidence[^]*\$4\.00/);
 assert.match(h.document.querySelector('#cost-total')!.textContent,/\$10\.00/);
 assert.match(h.document.querySelector('#cost-provider-total')!.textContent,/\$10\.00/);
});
