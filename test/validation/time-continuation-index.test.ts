import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { analyzeMachineSessions } from '../../src/analyzer.ts';
import { createSessionAnalyticsFixture } from '../fixtures.ts';

const jsonl=(records:unknown[])=>records.map(row=>JSON.stringify(row)).join('\n')+'\n';
const key=(id:string)=>createHash('sha256').update(`codex:${id}`).digest('hex').slice(0,12);
const counter=(input:number,output:number)=>({input_tokens:input,cached_input_tokens:0,output_tokens:output,reasoning_output_tokens:0});
const token=(at:string,input:number,output:number)=>({type:'event_msg',timestamp:at,payload:{type:'token_count',info:{total_token_usage:counter(input,output),last_token_usage:counter(input,output)}}});
const response=(at:string)=>({type:'response_item',timestamp:at,payload:{type:'message',role:'assistant',content:[]}});
const complete=(at:string)=>({type:'event_msg',timestamp:at,payload:{type:'task_complete'}});

test('time-continuation-index: another file changing continuation-only ownership invalidates the cached group',async()=>{
 const root=await mkdtemp(join(tmpdir(),'time-continuation-index-'));
 try {
  const fixture=await createSessionAnalyticsFixture(root);
  const options={...fixture,noIndex:false,pricingPolicy:'reviewed-only' as const};
  const a='aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',b='bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
  const identity=(id:string,at:string)=>({type:'session_meta',timestamp:at,payload:{id,cwd:fixture.repositoryRoot,source:'exec'}});
  const context=(at:string)=>({type:'turn_context',timestamp:at,payload:{model:'gpt-5.6-sol'}});
  await writeFile(join(fixture.codexRoot,`rollout-${a}.jsonl`),jsonl([
   identity(a,'2026-08-31T22:00:00Z'),context('2026-08-31T22:00:01Z'),response('2026-08-31T22:00:02Z'),token('2026-08-31T22:00:03Z',111,11),complete('2026-08-31T22:00:04Z'),
  ]));
  await writeFile(join(fixture.codexArchiveRoot,`rollout-${a}.jsonl`),jsonl([
   identity(a,'2026-09-01T00:00:00Z'),context('2026-09-01T00:00:01Z'),response('2026-09-01T00:01:00Z'),token('2026-09-01T00:01:01Z',10_000,100),complete('2026-09-01T00:01:02Z'),
  ]));
  const other=join(fixture.codexRoot,`rollout-${b}.jsonl`);
  await writeFile(other,jsonl([identity(b,'2026-09-01T00:00:00Z'),context('2026-09-01T00:00:01Z')]));
  const before=await analyzeMachineSessions(options);
  assert.equal(before.sessions.find(s=>s.sessionKey===key(a))!.tokens.inputTokens,10_111,'Prerequisite: continuation union is present');
  // Neither physical file in A changes. Only the competing observer reveals better ownership.
  await appendFile(other,jsonl([response('2026-09-01T00:01:00.900Z'),token('2026-09-01T00:01:01Z',10_000,100),complete('2026-09-01T00:01:02Z')]));
  const cached=await analyzeMachineSessions(options);
  assert.ok(!cached.warnings.some(warning => warning.includes("consistency check")), "Ordinary continuation dependency changes must invalidate without an audit fallback");
  const full=await analyzeMachineSessions({...options,noIndex:true});
  const select=(snapshot:typeof full)=>snapshot.sessions.filter(s=>[key(a),key(b)].includes(s.sessionKey)).map(s=>({key:s.sessionKey,input:s.tokens.inputTokens,output:s.tokens.outputTokens,days:s.spendByDay})).sort((x,y)=>x.key.localeCompare(y.key));
  assert.equal(full.sessions.find(s=>s.sessionKey===key(a))!.tokens.inputTokens,111);
  assert.equal(full.sessions.find(s=>s.sessionKey===key(b))!.tokens.inputTokens,10_000);
  assert.deepEqual(select(cached),select(full),'Every continuation ownership dependency must participate in cache invalidation');
 } finally {await rm(root,{recursive:true,force:true});}
});


test("native index: new ancestor call evidence invalidates an unchanged child projection", async () => {
 const root = await mkdtemp(join(tmpdir(), "native-call-index-"));
 try {
  const fixture = await createSessionAnalyticsFixture(root);
  const options = { ...fixture, noIndex: false, pricingPolicy: "reviewed-only" as const };
  const parent = "12121212-3434-4343-8343-121212121212", child = "56565656-7878-4787-8787-565656565656";
  const parentPath = join(fixture.codexRoot, `rollout-${parent}.jsonl`), childPath = join(fixture.codexRoot, `rollout-${child}.jsonl`);
  const call = { type: "response_item", timestamp: "2026-07-01T12:00:00Z", payload: { type: "function_call", name: "exec_command", call_id: "synthetic-inherited-call", arguments: "SYNTHETIC_PRIVATE_CALL" } };
  await writeFile(parentPath, jsonl([{ type: "session_meta", timestamp: "2026-07-01T00:00:00Z", payload: { id: parent, cwd: fixture.repositoryRoot, source: "cli" } }]));
  await writeFile(childPath, jsonl([{ type: "session_meta", timestamp: "2026-07-02T00:00:00Z", payload: { id: child, cwd: fixture.repositoryRoot, source: "cli", forked_from_id: parent } }, { ...call, timestamp: "2026-07-02T00:00:01Z" }, complete("2026-07-02T00:00:02Z")]));
  const initial = await analyzeMachineSessions(options);
  assert.equal(initial.sessions.find(session => session.sessionKey === key(child))!.metrics.transportToolCalls, 1);
  await appendFile(parentPath, jsonl([call, complete("2026-07-01T12:00:01Z")]));
  const changed = await analyzeMachineSessions(options);
  assert.equal(changed.sessions.find(session => session.sessionKey === key(child))!.metrics.transportToolCalls, 0);
  assert.ok(!changed.warnings.some(warning => warning.includes("consistency check")));
  assert.doesNotMatch(JSON.stringify(changed), /SYNTHETIC_PRIVATE_CALL|synthetic-inherited-call/);
 } finally { await rm(root, { recursive: true, force: true }); }
});
