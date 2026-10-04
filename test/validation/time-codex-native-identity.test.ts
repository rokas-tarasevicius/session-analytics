import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { analyzeMachineSessions } from '../../src/analyzer.ts';
import { createSessionAnalyticsFixture } from '../fixtures.ts';
const a='12121212-aaaa-4212-8212-121212121212',b='34343434-bbbb-4343-8343-343434343434';
const key=(id:string)=>createHash('sha256').update(`codex:${id}`).digest('hex').slice(0,12);
const usage={input_tokens:10000,cached_input_tokens:0,output_tokens:100,reasoning_output_tokens:0};
const stamp='2026-09-01T00:00:00Z';
const context={type:'turn_context',timestamp:stamp,payload:{model:'gpt-5.6-sol'}};
const native={type:'token_usage_record',timestamp:stamp,payload:{thread_id:a,response_id:'synthetic-response',usage,thread_token_usage:usage}};
const compaction={type:'compacted',timestamp:stamp,payload:{compaction_response_id:'synthetic-response'}};
const jsonl=(rows:unknown[])=>rows.map(row=>JSON.stringify(row)).join('\n')+'\n';

test('native identity: mirrored foreign response records and later metadata cannot replace the owning thread',async()=>{
 const root=await mkdtemp(join(tmpdir(),'time-native-identity-'));
 try{
  const f=await createSessionAnalyticsFixture(root);
  const meta=(id:string)=>({type:'session_meta',timestamp:stamp,payload:{id,cwd:f.repositoryRoot,source:'exec'}});
  await writeFile(join(f.codexRoot,`rollout-${a}.jsonl`),jsonl([meta(a),context,meta(b),native,compaction]));
  await writeFile(join(f.codexRoot,`rollout-${b}.jsonl`),jsonl([meta(b),context,native,compaction]));
  const result=await analyzeMachineSessions({...f,pricingPolicy:'reviewed-only'});
  assert.equal(result.sessions.find(s=>s.sessionKey===key(a))!.tokens.inputTokens,10000);
  assert.equal(result.sessions.find(s=>s.sessionKey===key(b))!.tokens.inputTokens,0);
  assert.doesNotMatch(JSON.stringify(result),/synthetic-response/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('native identity: repeated compaction response in continuation files is billed once with sole explicit model fallback',async()=>{
 const root=await mkdtemp(join(tmpdir(),'time-native-model-'));
 try{
  const f=await createSessionAnalyticsFixture(root);
  const meta={type:'session_meta',timestamp:stamp,payload:{id:a,cwd:f.repositoryRoot,source:'exec'}};
  await writeFile(join(f.codexRoot,`rollout-${a}.jsonl`),jsonl([meta,native,compaction,context]));
  await writeFile(join(f.codexArchiveRoot,`rollout-${a}.jsonl`),jsonl([meta,context,native,compaction]));
  const s=(await analyzeMachineSessions({...f,pricingPolicy:'reviewed-only'})).sessions.find(s=>s.sessionKey===key(a))!;
  assert.equal(s.tokens.inputTokens,10000);assert.equal(s.metrics.modelCalls,1);
  assert.ok(s.cost.totalUsd>0);assert.equal(s.models[0]!.model,'gpt-5.6-sol');
 }finally{await rm(root,{recursive:true,force:true});}
});
