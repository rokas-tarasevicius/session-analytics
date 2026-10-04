import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import test from 'node:test';
import {analyzeMachineSessions} from '../../src/analyzer.ts';
import {validateSnapshot} from '../../src/interop/snapshot.ts';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const at=(day:number,ms=0)=>new Date(Date.UTC(2026,0,day,0,0,0,ms)).toISOString();
function records(id:string,day:number,states:Array<[number,number]>) {
 return [{type:'session_meta',timestamp:at(day),payload:{id,cwd:'/synthetic/counter-ambiguity',source:'cli'}},{type:'turn_context',timestamp:at(day),payload:{model:'gpt-5.4'}},...states.flatMap(([total,last],i)=>[
  {type:'response_item',timestamp:at(day,i*2+1),payload:{type:'function_call',call_id:`synthetic-${id}-${i}`,name:'exec_command',arguments:'PRIVATE_SYNTHETIC_COUNTER_SENTINEL'}},
  {type:'event_msg',timestamp:at(day,i*2+2),payload:{type:'token_count',info:{total_token_usage:{input_tokens:total,cached_input_tokens:0,output_tokens:total/10,reasoning_output_tokens:0},last_token_usage:{input_tokens:last,cached_input_tokens:0,output_tokens:last/10,reasoning_output_tokens:0}}}},
 ])];
}
async function scan(groups:Array<{id:string,day:number,states:Array<[number,number]>}>) {
 const root=await mkdtemp(join(tmpdir(),'codex-counter-ambiguity-'));
 try {const active=join(root,'active'),archive=join(root,'archive'),claude=join(root,'claude');await Promise.all([mkdir(active),mkdir(archive),mkdir(claude)]);
  for(const g of groups)await writeFile(join(active,`rollout-${g.id}.jsonl`),records(g.id,g.day,g.states).map(r=>JSON.stringify(r)).join('\n')+'\n');
  const result=validateSnapshot(await analyzeMachineSessions({noIndex:true,additionalProviders:false,offline:true,pricingPolicy:'reviewed-only',dataDir:join(root,'data'),databasePath:join(root,'absent.db'),cursorDatabasePath:join(root,'absent-cursor.db'),claudeRoot:claude,codexRoot:active,codexArchiveRoot:archive}));
  const text=JSON.stringify(result);for(const forbidden of [A,B,root,'PRIVATE_SYNTHETIC_COUNTER_SENTINEL'])assert.ok(!text.includes(forbidden));return result.sessions.filter(s=>s.provider==='codex');
 } finally {await rm(root,{recursive:true,force:true});}
}
test('DEDUP-CX-01 mitigation: unresolved cross-file counter identity is qualified, without changing claims',async()=>{
 const sessions=await scan([{id:A,day:1,states:[[100,100]]},{id:B,day:2,states:[[100,100]]}]);
 assert.equal(sessions.reduce((sum,s)=>sum+s.tokens.inputTokens,0),100,'diagnostic proposal deliberately leaves the missing request unresolved');
 const excluded=sessions.find(s=>s.tokens.inputTokens===0)!;assert.equal(excluded.transcript.completeness,'partial');assert.equal(excluded.costComplete,true,'observed-token pricing coverage is unchanged');assert.ok(excluded.transcript.warnings.some(w=>w.includes('without a proven process/request identity')));
});
test('DEDUP-CX-06 mitigation: repeated states after decreases are qualified, without inventing reset identity',async()=>{
 const [session]=await scan([{id:A,day:1,states:[[100,100],[300,200],[100,100]]}]);
 assert.equal(session!.tokens.inputTokens,300,'diagnostic proposal deliberately leaves the final request unresolved');
 assert.equal(session!.transcript.completeness,'partial');assert.equal(session!.costComplete,true,'observed-token pricing coverage is unchanged');assert.ok(session!.transcript.warnings.some(w=>w.includes('without a proven reset/request identity')));
});
test('counter ambiguity control: an ordinary same-file repeated snapshot stays deduplicated',async()=>{
 const [session]=await scan([{id:A,day:1,states:[[100,100],[100,100]]}]);assert.equal(session!.tokens.inputTokens,100);assert.equal(session!.transcript.completeness,'complete');assert.ok(!session!.transcript.warnings.some(w=>w.includes('Accounting may be incomplete')));
});
