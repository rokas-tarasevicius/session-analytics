import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { analyzeMachineSessions } from '../../src/analyzer.ts';
import { createSessionAnalyticsFixture } from '../fixtures.ts';
const a='77777777-aaaa-4777-8777-aaaaaaaaaaaa',b='88888888-bbbb-4888-8888-bbbbbbbbbbbb';
const key=(id:string)=>createHash('sha256').update(`codex:${id}`).digest('hex').slice(0,12);
const at='2026-09-01T00:10:00Z',later='2026-09-01T00:20:00Z';
const usage=(input=10_000,output=100)=>({input_tokens:input,cached_input_tokens:0,output_tokens:output,reasoning_output_tokens:0});
const token=(date:string,total=usage(),last=usage())=>({type:'event_msg',timestamp:date,payload:{type:'token_count',info:{total_token_usage:total,last_token_usage:last}}});
const native=(id:string,date=at)=>({type:'token_usage_record',timestamp:date,payload:{thread_id:id,response_id:'synthetic-native-response',usage:usage(),thread_token_usage:usage()}});
const response=(date:string)=>({type:'response_item',timestamp:date,payload:{type:'message',role:'assistant',content:[]}});
const jsonl=(rows:unknown[])=>rows.map(r=>JSON.stringify(r)).join('\n')+'\n';
async function fixture(run:(f:Awaited<ReturnType<typeof createSessionAnalyticsFixture>>,write:(id:string,records:unknown[])=>Promise<void>)=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'time-native-review-'));
 try{const f=await createSessionAnalyticsFixture(root);const write=async(id:string,records:unknown[])=>{await writeFile(join(f.codexRoot,`rollout-${id}.jsonl`),jsonl([{type:'session_meta',timestamp:'2026-09-01T00:00:00Z',payload:{id,cwd:f.repositoryRoot,source:'exec'}},{type:'turn_context',timestamp:'2026-09-01T00:00:01Z',payload:{model:'gpt-5.6-sol'}},...records]));};await run(f,write);}finally{await rm(root,{recursive:true,force:true});}
}

test('time-native-review: legacy observation before its matching native receipt is not billed twice',async()=>{
 await fixture(async(f,write)=>{
  await write(a,[response(at),token(at),native(a)]);
  const s=(await analyzeMachineSessions({...f,pricingPolicy:'reviewed-only'})).sessions.find(s=>s.sessionKey===key(a))!;
  assert.equal(s.tokens.inputTokens,10_000);assert.equal(s.metrics.modelCalls,1);
 });
});

test('time-native-review: one native compaction receipt cannot erase a distinct later legacy request',async()=>{
 await fixture(async(f,write)=>{
  await write(a,[native(a),{type:'compacted',timestamp:at,payload:{compaction_response_id:'synthetic-native-response'}},response(later),token(later,usage(30_000,300),usage(20_000,200))]);
  const s=(await analyzeMachineSessions({...f,pricingPolicy:'reviewed-only'})).sessions.find(s=>s.sessionKey===key(a))!;
  assert.equal(s.tokens.inputTokens,30_000);assert.equal(s.tokens.outputTokens,300);assert.equal(s.metrics.modelCalls,2);
 });
});

test('time-native-review: a later equal-size legacy request is not globally reserved by an older native receipt',async()=>{
 await fixture(async(f,write)=>{
  const next=token(later,usage(20_000,200),usage());
  await write(a,[native(a),token(at),next]);
  await write(b,[response(later),next]);
  const s=(await analyzeMachineSessions({...f,pricingPolicy:'reviewed-only'})).sessions.filter(s=>[key(a),key(b)].includes(s.sessionKey));
  assert.equal(s.reduce((n,s)=>n+s.tokens.inputTokens,0),20_000);
  assert.equal(s.find(s=>s.sessionKey===key(b))!.tokens.inputTokens,10_000);
 });
});

test('time-native-review: a cumulative delta cannot rebill an intervening native compaction',async()=>{
 await fixture(async(f,write)=>{
  const receipt={type:'token_usage_record',timestamp:at,payload:{thread_id:a,response_id:'synthetic-native-response',usage:usage(20_000,200),thread_token_usage:usage(120_000,1_200)}};
  await write(a,[response('2026-09-01T00:05:00Z'),token('2026-09-01T00:05:00Z',usage(100_000,1_000),usage()),receipt,
   {type:'compacted',timestamp:at,payload:{compaction_response_id:'synthetic-native-response'}},
   {type:'event_msg',timestamp:later,payload:{type:'token_count',info:{total_token_usage:usage(120_000,1_200)}}},
  ]);
  const s=(await analyzeMachineSessions({...f,pricingPolicy:'reviewed-only'})).sessions.find(s=>s.sessionKey===key(a))!;
  assert.equal(s.tokens.inputTokens,30_000,'Native compaction cannot also enter a cumulative difference across its record');
  assert.equal(s.tokens.outputTokens,300);assert.equal(s.metrics.modelCalls,2);
 });
});
