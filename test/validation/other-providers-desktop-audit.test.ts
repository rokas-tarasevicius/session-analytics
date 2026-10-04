import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname,join } from 'node:path';
import test from 'node:test';
import { analyzeMachineSessions } from '../../src/analyzer.ts';
import { validateSnapshot } from '../../src/interop/snapshot.ts';

const id='11111111-1111-4111-8111-111111111111',localId='local_22222222-2222-4222-8222-222222222222';
const opus='claude-opus-4-6',haiku='claude-haiku-4-5-20251001';
const sentinel='PRIVATE-DESKTOP-AUDIT-SENTINEL';
const at=(minute:number,second:number)=>`2026-04-11T10:${String(minute).padStart(2,'0')}:${String(second).padStart(2,'0')}.000Z`;
async function put(p:string,rows:unknown[]){await mkdir(dirname(p),{recursive:true});await writeFile(p,rows.map(x=>JSON.stringify(x)).join('\n')+'\n');}
function result(uuid:string,minute:number,input:number,output:number,helperInput:number,helperOutput:number){return {type:'result',uuid,session_id:id,_audit_timestamp:at(minute,3),is_error:false,subtype:'success',result:sentinel,usage:{input_tokens:input,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:output},modelUsage:{[opus]:{inputTokens:input,cacheReadInputTokens:0,cacheCreationInputTokens:0,outputTokens:output},[haiku]:{inputTokens:helperInput,cacheReadInputTokens:0,cacheCreationInputTokens:0,outputTokens:helperOutput}}};}
for(const variant of [
 {name:'DESKTOP-02: latest result replaces streamed placeholder output and adds absent helper usage once',version:'2.1.78',second:false,conflict:false,input:15,output:23},
 {name:'DESKTOP-02: distinct legacy init intervals add once while repeated cumulative receipts do not',version:'2.1.78',second:true,conflict:false,input:42,output:57},
 {name:'Desktop audit counter conflict preserves canonical native usage',version:'2.1.78',second:false,conflict:true,input:10,output:2},
 {name:'Desktop audit resumed-session carryover versions remain guarded',version:'2.1.300',second:true,conflict:false,input:30,output:6},
])test(variant.name,async()=>{
 const root=await mkdtemp(join(tmpdir(),'desktop-audit-validation-'));
 try{
  const desktop=join(root,'local-agent-mode-sessions'),container=join(desktop,'account','organization',localId),native=[] as unknown[],audit=[] as unknown[];
  await put(`${container}.json`,[{sessionId:localId,cliSessionId:id,cwd:root,title:sentinel}]);
  for(let minute=0;minute<(variant.second?2:1);minute++){
   const input=minute?20:10,output=minute?4:2,message={id:`native-${minute}`,model:opus,content:[{type:'text',text:sentinel}],usage:{input_tokens:input,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:output}};
   native.push({type:'assistant',sessionId:id,cwd:root,entrypoint:'local-agent',timestamp:at(minute,1),message});
   audit.push({type:'system',subtype:'init',uuid:`init-${minute}`,session_id:id,claude_code_version:variant.version,_audit_timestamp:at(minute,0)});
   audit.push({type:'assistant',session_id:id,_audit_timestamp:at(minute,1),message});
   audit.push(result(`intermediate-${minute}`,minute,input,minute?25:12,minute?6:3,minute?3:1));
   const receipt=result(`final-${minute}`,minute,variant.conflict?input+1:input,minute?30:20,minute?7:5,minute?4:3);
   audit.push(receipt,receipt);
  }
  await put(join(container,'.claude','projects','synthetic',`${id}.jsonl`),native);
  await put(join(container,'audit.jsonl'),audit);
  const data=validateSnapshot(await analyzeMachineSessions({noIndex:true,additionalProviders:false,claudeRoot:desktop,codexRoot:join(root,'none-codex'),codexArchiveRoot:join(root,'none-archive'),cursorDatabasePath:join(root,'none-cursor'),databasePath:join(root,'none-conductor'),dataDir:join(root,'data'),pricingPolicy:'reviewed-only'}));
  assert.equal(data.sessions.length,1);
  const session=data.sessions[0]!;
  for(const secret of [sentinel,root,id,localId])assert.ok(!JSON.stringify(data).includes(secret),'content and private identities must stay internal');
  assert.equal(session.metrics.assistantMessages,variant.second?2:1);
  assert.equal(session.metrics.modelCalls,variant.second?2:1,'summary usage must not fabricate model calls');
  assert.equal(session.tokens.inputTokens,variant.input);
  assert.equal(session.tokens.outputTokens,variant.output);
 }finally{await rm(root,{recursive:true,force:true});}
});
