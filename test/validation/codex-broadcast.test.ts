import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, context, counter, response, usage, timestamp } from './codex-fixture.ts';
const a='11111111-1111-4111-8111-111111111111', b='22222222-2222-4222-8222-222222222222';

test('CODEX-04: user notification cannot steal another thread model request', async()=>fixture(async f=>{
 const u=usage(1000,100,500,20);
 await f.write(a,[context(1,'gpt-5.6-sol'),response(2),counter(4,u,u)]);
 await f.write(b,[context(1,'gpt-6-astra'),{type:'event_msg',timestamp:timestamp(3),payload:{type:'user_message',message:'SYNTHETIC-CONTENT-SENTINEL'}},counter(4,u,u)]);
 const result=await f.analyze();
 const sol=result.sessions.find(s=>s.models.some(m=>m.model==='gpt-5.6-sol'));
 assert.equal(sol?.tokens.inputTokens,1000,'Generated response owns usage; a later user notification is not a model response');
 assert.equal(result.summary.totalInputTokens,1000);
 assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC-CONTENT-SENTINEL/);
}));

test('CODEX-05: shared cumulative-only delta must not be charged in both receivers', async()=>fixture(async f=>{
 const baseline=usage(10000,1000,8000), end=usage(11000,1100,8500);
 await f.write(a,[context(1),counter(2,baseline),response(3),counter(4,end)]);
 await f.write(b,[context(1),counter(2,baseline),counter(4,end)]);
 const result=await f.analyze();
 assert.equal(result.summary.totalInputTokens,1000,'One shared process increment is counted only once');
 assert.equal(result.summary.outputTokens,100);
}));

test('LIMIT-01: counter-only identity ambiguity is explicitly qualified', async()=>fixture(async f=>{
 const u=usage(1000,100,500,20);
 await f.write(a,[context(1),response(2,'synthetic-independent-a'),counter(3,u,u)]);
 await f.write(b,[context(100),response(101,'synthetic-independent-b'),counter(102,u,u)]);
 const result=await f.analyze();
 assert.equal(result.summary.totalInputTokens,1000,'Counter-only ambiguity retains conservative claims until provider response identity resolves multiplicity');
 assert.equal(result.summary.outputTokens,100);
 assert.ok(result.sessions.some(session => session.transcript.warnings.some(warning => warning.includes('without a proven process/request identity'))));
}));
