import assert from 'node:assert/strict';
import test from 'node:test';
import { harness, sample } from './aggregation-ui-harness.ts';

test('AGG-003: Models discloses provider-reported value without model attribution',async()=>{
 const h=await harness([sample()]);h.run('renderModels(activeView())');
 const text=h.document.querySelector('#models-by-provider')!.textContent;
 // Receipt says $10, but only $6 is attributable to a model. The other $4 must stay visible.
 assert.match(text,/\$4\.00[^]*[Uu]nattributed|[Uu]nattributed[^]*\$4\.00/);
});
