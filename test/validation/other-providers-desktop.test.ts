import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { analyzeMachineSessions, discoverProviderRoots } from '../../src/analyzer.ts';

const id='11111111-1111-4111-8111-111111111111';
const localId='local_22222222-2222-4222-8222-222222222222';
const sentinel='PRIVATE-DESKTOP-CONTENT-SENTINEL';
async function put(path:string,value:string){await mkdir(dirname(path),{recursive:true});await writeFile(path,value);}

for (const variant of [
 {name:'DESKTOP-01: verified Desktop metadata classifies older native records without entrypoint',matches:true,entrypoint:undefined,expected:'desktop'},
 {name:'Desktop metadata with a conflicting CLI identity does not classify the transcript',matches:false,entrypoint:undefined,expected:'unknown'},
 {name:'An explicit transcript entrypoint wins over Desktop metadata',matches:true,entrypoint:'cli',expected:'cli'},
]) test(variant.name, async()=>{
 const root=await mkdtemp(join(tmpdir(),'desktop-validation-'));
 try{
  const desktop=join(root,'local-agent-mode-sessions');
  const container=join(desktop,'account','organization',localId);
  const transcript=join(container,'.claude','projects','synthetic-project',`${id}.jsonl`);
  await put(`${container}.json`,JSON.stringify({sessionId:localId,cliSessionId:variant.matches?id:'33333333-3333-4333-8333-333333333333',cwd:root,title:sentinel,initialMessage:sentinel}));
  await put(transcript,JSON.stringify({type:'assistant',entrypoint:variant.entrypoint,sessionId:id,cwd:root,timestamp:'2026-03-05T20:35:00Z',message:{id:'synthetic-message',model:'claude-opus-4-6',content:[{type:'text',text:sentinel}],usage:{input_tokens:4,cache_read_input_tokens:100,cache_creation_input_tokens:20,output_tokens:5}}})+'\n');
  await put(join(container,'audit.jsonl'),JSON.stringify({type:'assistant',session_id:id,_audit_timestamp:'2026-03-05T20:35:00Z',message:{id:'synthetic-message',model:'claude-opus-4-6',usage:{input_tokens:4,cache_read_input_tokens:100,cache_creation_input_tokens:20,output_tokens:5}}})+'\n');
  const snapshot=await analyzeMachineSessions({claudeRoot:desktop,codexRoot:join(root,'empty-codex'),codexArchiveRoot:join(root,'empty-archive'),cursorDatabasePath:join(root,'missing-cursor'),databasePath:join(root,'missing-conductor'),additionalProviders:false,noIndex:true,pricingPolicy:'reviewed-only',dataDir:join(root,'data')});
  assert.equal(snapshot.sessions.length,1);
  const serialized=JSON.stringify(snapshot);
  for(const secret of [sentinel,id,localId,root])assert.ok(!serialized.includes(secret),'private fixture evidence must remain private');
  assert.equal(snapshot.sessions[0]!.tokens.inputTokens,124);
  assert.equal(snapshot.sessions[0]!.agentIdentity?.claudeEntrypoint,variant.expected);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('Desktop and explicit provider roots are discovered with canonical root deduplication',async()=>{
 const root=await mkdtemp(join(tmpdir(),'desktop-discovery-validation-'));
 try{
  const claude=join(root,'.claude','projects'),desktop=join(root,'Library/Application Support/Claude/local-agent-mode-sessions'),codex=join(root,'.codex','sessions');
  await Promise.all([claude,desktop,codex].map(p=>mkdir(p,{recursive:true})));
  const actual=await discoverProviderRoots({home:root,claudeConfigDirectory:join(root,'.claude'),codexHome:join(root,'.codex')});
  assert.equal(actual.claude.filter(p=>p===claude).length,1);
  assert.ok(actual.claude.includes(desktop));
  assert.equal(actual.codex.filter(p=>p===codex).length,1);
 }finally{await rm(root,{recursive:true,force:true});}
});
