import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { analyzeMachineSessions } from '../../src/analyzer.ts';
import { createSessionAnalyticsFixture } from '../fixtures.ts';

const key = (id: string) => createHash('sha256').update(`codex:${id}`).digest('hex').slice(0, 12);
const usage = { input_tokens: 10_000, cached_input_tokens: 2_000, output_tokens: 100, reasoning_output_tokens: 20 };
const meta = (id: string, cwd: string) => ({ type:'session_meta', timestamp:'2026-08-31T22:00:00Z', payload:{ id, cwd, source:'exec' } });
const context = { type:'turn_context', timestamp:'2026-08-31T22:00:01Z', payload:{ model:'gpt-5.6-sol' } };
const token = (timestamp: string | null) => ({ type:'event_msg', timestamp, payload:{ type:'token_count', info:{total_token_usage:usage,last_token_usage:usage} } });
const jsonl = (records: unknown[]) => records.map(r=>JSON.stringify(r)).join('\n')+'\n';

for (const timestamp of [null, 'invalid-timestamp']) {
 test(`TIME-CODEX-UNDATED: ${timestamp === null ? 'missing' : 'invalid'} request date must stay out of spendByDay and MCP periods`, async () => {
  const root=await mkdtemp(join(tmpdir(),'time-codex-undated-'));
  try {
   const fixture=await createSessionAnalyticsFixture(root);
   const id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
   await writeFile(join(fixture.codexRoot,`rollout-${id}.jsonl`),jsonl([meta(id,fixture.repositoryRoot),context,token(timestamp)]));
   const result=await analyzeMachineSessions({...fixture,pricingPolicy:'reviewed-only'});
   const s=result.sessions.find(s=>s.sessionKey===key(id));assert.ok(s);
   assert.ok(s.cost.totalUsd>0);assert.equal(s.velocity?.undated.reduce((n,c)=>n+c[1][0],0),s.cost.totalUsd);
   assert.deepEqual(s.spendByDay,{},'No raw request date supports a daily accounting bucket');
   assert.deepEqual(s.mcpEvidence?.pricingByDay,[]);
   assert.equal(s.mcpEvidence?.undatedTokens,10_100);
  } finally { await rm(root,{recursive:true,force:true}); }
 });
}

test('TIME-CODEX-OWNER: a user-message receiver cannot move an August response into September', async () => {
 const root=await mkdtemp(join(tmpdir(),'time-codex-owner-'));
 try {
  const fixture=await createSessionAnalyticsFixture(root);
  const a='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', b='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await writeFile(join(fixture.codexRoot,`rollout-${a}.jsonl`),jsonl([meta(a,fixture.repositoryRoot),context,
   { type:'response_item',timestamp:'2026-08-31T23:59:59.800Z',payload:{type:'message',role:'assistant',content:[]} },token('2026-08-31T23:59:59.900Z')]));
  await writeFile(join(fixture.codexRoot,`rollout-${b}.jsonl`),jsonl([meta(b,fixture.repositoryRoot),context,
   { type:'event_msg',timestamp:'2026-09-01T00:00:00.000Z',payload:{type:'user_message',message:'synthetic-private-sentinel'} },token('2026-09-01T00:00:00.001Z')]));
  const result=await analyzeMachineSessions({...fixture,pricingPolicy:'reviewed-only'});
  assert.doesNotMatch(JSON.stringify(result),/synthetic-private-sentinel/);
  const owner=result.sessions.find(s=>s.sessionKey===key(a))!,receiver=result.sessions.find(s=>s.sessionKey===key(b))!;
  assert.equal(owner.tokens.inputTokens,10_000,'Model response owns its request despite unrelated activity in a receiver');
  assert.equal(receiver.tokens.inputTokens,0);
  assert.equal(owner.spendByDay['2026-08-31'],owner.cost.totalUsd);assert.equal(receiver.spendByDay['2026-09-01']??0,0);
 } finally { await rm(root,{recursive:true,force:true}); }
});

for (const separator of ['\u2028', '\u2029']) {
 test(`TIME-JSONL-SEPARATOR: U+${separator.charCodeAt(0).toString(16)} inside JSON text must not break date ownership`, async () => {
  const root=await mkdtemp(join(tmpdir(),'time-jsonl-separator-'));
  try {
   const fixture=await createSessionAnalyticsFixture(root);
   const a='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',b='ffffffff-ffff-4fff-8fff-ffffffffffff';
   await writeFile(join(fixture.codexRoot,`rollout-${a}.jsonl`),jsonl([meta(a,fixture.repositoryRoot),context,
    {type:'response_item',timestamp:'2026-08-31T23:59:59.800Z',payload:{type:'function_call',name:'synthetic_tool',call_id:'synthetic-call',arguments:'{}'}},
    {type:'response_item',timestamp:'2026-08-31T23:59:59.900Z',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:`synthetic-private${separator}sentinel`}]}},token('2026-08-31T23:59:59.900Z')]));
   await writeFile(join(fixture.codexRoot,`rollout-${b}.jsonl`),jsonl([meta(b,fixture.repositoryRoot),context,
    {type:'event_msg',timestamp:'2026-09-01T00:00:00Z',payload:{type:'item_completed',item:{type:'AgentMessage',id:'synthetic-item'}}},token('2026-09-01T00:00:00Z')]));
   const result=await analyzeMachineSessions({...fixture,pricingPolicy:'reviewed-only'});
   const owner=result.sessions.find(s=>s.sessionKey===key(a))!,receiver=result.sessions.find(s=>s.sessionKey===key(b))!;
   assert.doesNotMatch(JSON.stringify(result),/synthetic-private|sentinel/);
   assert.equal(owner.tokens.inputTokens,10_000,'Valid JSON output preserves original activity timestamp and earlier-date tie break');
   assert.equal(receiver.tokens.inputTokens,0);
   assert.equal(owner.transcript.warnings.some(s=>s.includes('malformed')),false);
  } finally { await rm(root,{recursive:true,force:true}); }
 });
}

for (const filenameMatchesIdentity of [true, false]) {
test(`TIME-CODEX-CONTINUATION: ${filenameMatchesIdentity ? 'same-identity filename' : 'metadata identity differing from filename'} segments contribute their own dates`, async () => {
 const root=await mkdtemp(join(tmpdir(),'time-codex-continuation-'));
 try {
  const fixture=await createSessionAnalyticsFixture(root);
  const id='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  await writeFile(join(fixture.codexRoot,`rollout-${id}.jsonl`),jsonl([meta(id,fixture.repositoryRoot),context,token('2026-08-31T23:59:00Z')]));
  const next={...usage,input_tokens:20_000,output_tokens:200};
  await writeFile(join(fixture.codexArchiveRoot,`rollout-${filenameMatchesIdentity ? id : '12121212-1212-4212-8212-121212121212'}.jsonl`),jsonl([
   {...meta(id,fixture.repositoryRoot),timestamp:'2026-09-01T00:00:00Z'},
   {...context,timestamp:'2026-09-01T00:00:01Z'},
   {type:'event_msg',timestamp:'2026-09-01T00:02:00Z',payload:{type:'token_count',info:{total_token_usage:next,last_token_usage:usage}}}
  ]));
  const result=await analyzeMachineSessions({...fixture,pricingPolicy:'reviewed-only'});
  const s=result.sessions.find(s=>s.sessionKey===key(id))!;
  assert.equal(s.tokens.inputTokens,20_000,'Both same-identity physical segments contain distinct requests');
  assert.equal(s.transcript.files,2);
  assert.ok((s.spendByDay['2026-08-31']??0)>0);assert.ok((s.spendByDay['2026-09-01']??0)>0);
  assert.equal(s.lastEventAt,'2026-09-01T00:02:00.000Z');
 } finally { await rm(root,{recursive:true,force:true}); }
});
}

test('TIME-CODEX-CONTINUATION: exact copies cannot duplicate cumulative fallback usage', async () => {
 const root=await mkdtemp(join(tmpdir(),'time-codex-copy-'));
 try {
  const fixture=await createSessionAnalyticsFixture(root);
  const id='45454545-4545-4454-8454-454545454545';
  const copy=jsonl([meta(id,fixture.repositoryRoot),context,token('2026-08-31T23:59:00Z'),
   {type:'event_msg',timestamp:'2026-09-01T00:01:00Z',payload:{type:'token_count',info:{
    total_token_usage:{input_tokens:20_000,cached_input_tokens:4_000,output_tokens:200,reasoning_output_tokens:40},
    last_token_usage:{input_tokens:0,cached_input_tokens:0,output_tokens:0,reasoning_output_tokens:0}
   }}}
  ]);
  await writeFile(join(fixture.codexRoot,`rollout-${id}.jsonl`),copy);
  await writeFile(join(fixture.codexArchiveRoot,`rollout-${id}.jsonl`),copy);
  const result=await analyzeMachineSessions({...fixture,pricingPolicy:'reviewed-only'});
  const s=result.sessions.find(s=>s.sessionKey===key(id))!;
  assert.equal(s.tokens.inputTokens,20_000,'Exact copies contribute the legacy delta once');
  assert.equal(s.tokens.outputTokens,200);
  assert.equal(s.metrics.modelCalls,2);
  assert.equal(s.transcript.files,1);
 } finally { await rm(root,{recursive:true,force:true}); }
});

test('TIME-CODEX-NATIVE-USAGE: compaction response usage keeps its own month even without token_count', async () => {
 const root=await mkdtemp(join(tmpdir(),'time-codex-native-'));
 try {
  const fixture=await createSessionAnalyticsFixture(root),id='98989898-9898-4989-8989-989898989898';
  await writeFile(join(fixture.codexRoot,`rollout-${id}.jsonl`),jsonl([meta(id,fixture.repositoryRoot),context,token('2026-08-31T23:59:00Z'),
   {type:'token_usage_record',timestamp:'2026-09-01T00:00:02Z',payload:{thread_id:id,response_id:'synthetic-compaction-response',usage}},
   {type:'compacted',timestamp:'2026-09-01T00:00:03Z',payload:{compaction_response_id:'synthetic-compaction-response',message:'synthetic-private-compaction'}}
  ]));
  const result=await analyzeMachineSessions({...fixture,pricingPolicy:'reviewed-only'}),s=result.sessions.find(s=>s.sessionKey===key(id))!;
  assert.doesNotMatch(JSON.stringify(result),/synthetic-private-compaction|synthetic-compaction-response/);
  assert.equal(s.tokens.inputTokens,20_000,'Explicit billed compaction response supplements legacy request prefix');
  assert.ok((s.spendByDay['2026-09-01']??0)>0);
 } finally { await rm(root,{recursive:true,force:true}); }
});

test('TIME-CODEX-NATIVE-COLLISION: distinct native response identities must survive identical numeric states', async () => {
 const root=await mkdtemp(join(tmpdir(),'time-codex-native-collision-'));
 try {
  const fixture=await createSessionAnalyticsFixture(root);
  const ids=['97979797-9797-4979-8979-979797979797','96969696-9696-4969-8969-969696969696'];
  for(const [index,id] of ids.entries()){
   const date=index===0?'2026-08-31T23:59:00Z':'2026-09-01T00:00:00Z';
   await writeFile(join(fixture.codexRoot,`rollout-${id}.jsonl`),jsonl([meta(id!,fixture.repositoryRoot),context,
    {type:'token_usage_record',timestamp:date,payload:{thread_id:id,response_id:`synthetic-distinct-response-${index}`,usage,thread_token_usage:usage}},token(date)
   ]));
  }
  const result=await analyzeMachineSessions({...fixture,pricingPolicy:'reviewed-only'});
  for(const id of ids)assert.equal(result.sessions.find(s=>s.sessionKey===key(id))!.tokens.inputTokens,10_000,'Separate native responses are not repeated broadcasts');
 } finally { await rm(root,{recursive:true,force:true}); }
});
