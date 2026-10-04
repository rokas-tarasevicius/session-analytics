import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { cursorSessions } from '../../src/analyzer.ts';
import { additionalProviderSessions } from '../../src/providers/index.ts';
import { opencodeAdapter } from '../../src/providers/opencode.ts';
import { zeroCost } from '../../src/providers/common.ts';
import type { ProviderContext } from '../../src/providers/adapter.ts';
import type { AnalyzeOptions } from '../../src/types.ts';
const at='2026-09-01T12:00:00.000Z',later='2026-09-02T12:00:00.000Z';
const uid='11111111-1111-4111-8111-111111111111';
const context: ProviderContext={repository:{id:'synthetic',name:'Synthetic'},rateCard:{currency:'USD',effectiveDate:'2026-09-01',models:{}},price:()=>zeroCost()};
async function fixture(fn:(root:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'dedup-adapters-'));try{await fn(root);}finally{await rm(root,{recursive:true,force:true});}}
async function rows(path:string,values:unknown[]){await mkdir(dirname(path),{recursive:true});await writeFile(path,values.map(x=>JSON.stringify(x)).join('\n')+'\n');}
const collect=(home:string,options:AnalyzeOptions)=>additionalProviderSessions({home,environment:{},options:{additionalProviders:false,...options},knownPaths:[],existingSessions:[],pricing:context,repositoryForSession:async()=>context.repository});
async function sdkStore(root:string,store:string,runs:Array<{id:string,input:number,updated?:string}>){const p=join(root,store);await rows(join(p,'agents.ndjson'),[{agentId:uid,cwd:'/synthetic/repo',createdAt:at,updatedAt:later}]);await rows(join(p,'runs.ndjson'),runs.map(r=>({agentId:uid,runId:r.id,status:'finished',createdAt:at,startedAt:at,endedAt:r.updated??at,updatedAt:r.updated??at,model:{id:'synthetic-model'},usage:{inputTokens:r.input,outputTokens:10}})));await rows(join(p,'run_events.ndjson'),[]);}

test('DEDUP-AD-01: Cursor SDK copies retain distinct runs and latest duplicate run snapshots',async()=>fixture(async root=>{
  await sdkStore(root,'a-old',[{id:'shared',input:100}]);
  await sdkStore(root,'z-new',[{id:'shared',input:150,updated:later},{id:'new',input:200,updated:later}]);
  const result=await collect(root,{cursorSdkRoot:root});
  assert.equal(result.sessions.length,1);
  assert.equal(result.sessions[0]!.tokens.inputTokens,350,'the first directory must not discard continued evidence from another copy');
  assert.equal(result.sessions[0]!.metrics.taskStarts,2);
}));

test('DEDUP-AD-01: duplicate Cursor activity transcripts choose the more complete current copy',async()=>fixture(async root=>{
  const user={role:'user',message:{content:[{type:'text',text:'synthetic'}]}};
  await rows(join(root,'a-project','agent-transcripts',uid+'.jsonl'),[user]);
  await rows(join(root,'z-project','agent-transcripts',uid+'.jsonl'),[user,{role:'assistant',message:{content:[{type:'tool_use',id:'synthetic-call',name:'Read'}]}}]);
  await utimes(join(root,'a-project','agent-transcripts',uid+'.jsonl'),new Date(at),new Date(at));
  await utimes(join(root,'z-project','agent-transcripts',uid+'.jsonl'),new Date(later),new Date(later));
  const result=await collect(root,{cursorTranscriptRoot:root});
  assert.equal(result.sessions.length,1);assert.equal(result.sessions[0]!.metrics.assistantMessages,1);
}));

test('DEDUP-AD-02: missing runs file in one Cursor store does not abandon later healthy stores',async()=>fixture(async root=>{
  await rows(join(root,'a-broken','agents.ndjson'),[{agentId:'broken',cwd:'/synthetic',createdAt:at}]);
  await sdkStore(root,'z-healthy',[{id:'new',input:200}]);
  const result=await collect(root,{cursorSdkRoot:root});
  assert.equal(result.sessions.length,1);assert.equal(result.sessions[0]!.tokens.inputTokens,200);
  assert.ok(result.warnings.length>0,'the skipped broken store must remain visible as partial source coverage');
}));

test('DEDUP-AD-02: oversized Gemini history does not abandon a healthy sibling',async()=>fixture(async root=>{
  const chats=join(root,'project','chats');await mkdir(chats,{recursive:true});
  await writeFile(join(chats,'session-a.json'),JSON.stringify({sessionId:'oversized',projectHash:'synthetic',startTime:at,messages:[],padding:'x'.repeat(4*1024*1024)}));
  await writeFile(join(chats,'session-z.json'),JSON.stringify({sessionId:'healthy',projectHash:'synthetic',startTime:at,messages:[{id:'response',type:'gemini',timestamp:at,tokens:{input:200,output:10}}]}));
  const result=await collect(root,{geminiRoot:root});
  assert.equal(result.sessions.length,1);assert.equal(result.sessions[0]!.tokens.inputTokens,200);
  assert.ok(result.warnings.length>0);
}));

test('DEDUP-AD-01: Gemini same-format copy selection must not prefer stale lexical filename',async()=>fixture(async root=>{
  const chats=join(root,'project','chats');
  for(const [name,input,updated]of [['a',100,at],['z',300,later]] as const)await rows(join(chats,`session-${name}.jsonl`),[{sessionId:'same',projectHash:'synthetic',startTime:at,lastUpdated:updated},{id:'response',type:'gemini',timestamp:updated,tokens:{input,output:10}}]);
  const result=await collect(root,{geminiRoot:root});assert.equal(result.sessions.length,1);assert.equal(result.sessions[0]!.tokens.inputTokens,300);
}));

async function composer(root:string,inline:unknown[],modern:unknown[]){const path=join(root,'state.vscdb');const db=new DatabaseSync(path);db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY,value TEXT); CREATE TABLE ItemTable (key TEXT PRIMARY KEY,value TEXT)');db.prepare('INSERT INTO cursorDiskKV VALUES (?,?)').run('composerData:synthetic',JSON.stringify({composerId:'synthetic',createdAt:Date.parse(at),lastUpdatedAt:Date.parse(later),conversation:inline}));for(const [i,bubble]of modern.entries())db.prepare('INSERT INTO cursorDiskKV VALUES (?,?)').run('bubbleId:synthetic:'+i,JSON.stringify(bubble));db.close();const result=await cursorSessions(path,[],new Map(),new Map());assert.equal(result.warning,null);return result.sessions[0]!;}
test('DEDUP-AD-03: current Cursor disk bubble supersedes stale inline snapshot',async()=>fixture(async root=>{
  const s=await composer(root,[{bubbleId:'b',type:2,tokenCount:{inputTokens:100,outputTokens:1}}],[{bubbleId:'b',type:2,tokenCount:{inputTokens:100,outputTokens:50}}]);
  assert.equal(s.tokens.inputTokens,100);assert.equal(s.tokens.outputTokens,50);assert.equal(s.metrics.assistantMessages,1);
}));
test('DEDUP-AD-03: repeated inline Cursor bubble IDs do not bill a response twice',async()=>fixture(async root=>{
  const s=await composer(root,[{bubbleId:'b',type:2,tokenCount:{inputTokens:100,outputTokens:10}},{bubbleId:'b',type:2,tokenCount:{inputTokens:100,outputTokens:50}}],[]);
  assert.equal(s.tokens.inputTokens,100);assert.equal(s.tokens.outputTokens,50);assert.equal(s.metrics.assistantMessages,1);
}));

test('DEDUP-AD-04: OpenCode inherited response at the exact fork millisecond is billed once',async()=>fixture(async root=>{
  const path=join(root,'opencode.db');const db=new DatabaseSync(path);db.exec('CREATE TABLE session (id TEXT PRIMARY KEY,parent_id TEXT,directory TEXT,time_created INTEGER,time_updated INTEGER); CREATE TABLE message (id TEXT PRIMARY KEY,session_id TEXT,data TEXT); CREATE TABLE part (id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT)');
  for(const [id,created]of [['original',at],['fork',later]] as const){db.prepare('INSERT INTO session VALUES (?,NULL,?,?,?)').run(id,'/synthetic',Date.parse(created),Date.parse(later));db.prepare('INSERT INTO message VALUES (?,?,?)').run(id+'-message',id,JSON.stringify({role:'assistant',modelID:'synthetic-model',time:{created:Date.parse(later),completed:Date.parse(later)},tokens:{input:100,output:20}}));}
  db.close();const sessions=[];for await(const id of opencodeAdapter.identify(path))sessions.push((await opencodeAdapter.analyze(id,context))!);
  assert.equal(sessions.reduce((n,s)=>n+s.tokens.inputTokens,0),100,'copy timestamps can equal fork creation at millisecond resolution');
}));

test('DEDUP-AD-05: Copilot malformed start does not hide a later matching start',async()=>fixture(async root=>{
  const start=(id:string,data:unknown)=>({id,type:'session.start',timestamp:at,data});
  await rows(join(root,uid,'events.jsonl'),[start('bad',{}),start('good',{sessionId:uid,context:{cwd:'/synthetic'}}),{id:'message',type:'user.message',timestamp:later,data:{}}]);
  const result=await collect(root,{copilotRoot:root});assert.equal(result.sessions.length,1);assert.equal(result.sessions[0]!.metrics.userTurns,1);
}));
