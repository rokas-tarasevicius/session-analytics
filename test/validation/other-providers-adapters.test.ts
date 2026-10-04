import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { copilotAdapter } from '../../src/providers/copilot.ts';
import { geminiAdapter } from '../../src/providers/gemini.ts';
import { opencodeAdapter } from '../../src/providers/opencode.ts';
import { additionalProviderSessions } from '../../src/providers/index.ts';
import type { ProviderContext } from '../../src/providers/adapter.ts';
import { geminiCounters, geminiReplay, openCodeCounters, copilotCounters } from '../../verify/other-providers/adapters-oracle.ts';

const at='2026-07-20T09:00:00.000Z';
const sentinel='SYNTHETIC_PRIVATE_CONTENT';
const rate={provider:'gemini' as const,inputPerMillion:1,outputPerMillion:2,source:'https://example.invalid/synthetic'};
const context:ProviderContext={repository:{id:'synthetic-repository',name:'Synthetic'},rateCard:{currency:'USD',effectiveDate:'2026-01-01',models:{'synthetic-model':rate}},price:(_rate,usage)=>({inputUsd:usage.inputTokens/1e6,cachedInputUsd:0,cacheWriteUsd:0,outputUsd:usage.outputTokens*2/1e6,totalUsd:(usage.inputTokens+usage.outputTokens*2)/1e6,upperEstimateUsd:(usage.inputTokens+usage.outputTokens*2)/1e6})};
const header={sessionId:'synthetic-old-session',projectHash:'synthetic-project',startTime:at,lastUpdated:at};
const assistant={id:'a',type:'gemini',timestamp:at,model:'synthetic-model',tokens:{input:100,output:20,thoughts:5,cached:40},content:sentinel};
async function fixture(fn:(root:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'adapter-validation-'));try{await fn(root);}finally{await rm(root,{recursive:true,force:true});}}
async function jsonl(path:string,rows:unknown[]){await mkdir(dirname(path),{recursive:true});await writeFile(path,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');}
async function analyzeGemini(root:string,records:unknown[]){const path=join(root,'session-synthetic.jsonl');await jsonl(path,records);const s=await geminiAdapter().analyze({id:header.sessionId,path,cwd:null,createdAt:at,updatedAt:at},context);assert.ok(s);assert.ok(!JSON.stringify(s).includes(sentinel));return s;}

test('ADAPTER-001: Gemini rewind to an info record preserves usage before that record',async()=>fixture(async root=>{
 const records=[header,assistant,{id:'info',type:'info',timestamp:at,content:sentinel},{...assistant,id:'b'},{ $rewindTo:'info'}];
 const expected=geminiCounters(records);assert.equal(expected.input,100);
 const s=await analyzeGemini(root,records);assert.equal(s.tokens.inputTokens,expected.input);assert.equal(s.tokens.outputTokens,expected.output);
}));

test('ADAPTER-001: Gemini full replacement by non-accounting message erases old token counters',async()=>fixture(async root=>{
 const records=[header,assistant,{id:'a',type:'error',timestamp:at,content:sentinel}];
 const expected=geminiCounters(records);assert.equal(expected.input,0);
 const s=await analyzeGemini(root,records);assert.equal(s.tokens.inputTokens,expected.input);
}));

test('ADAPTER-002: Gemini resumed session identity follows the persisted metadata update',async()=>fixture(async root=>{
 const records=[header,assistant,{$set:{sessionId:'synthetic-resumed-session'}}];
 const path=join(root,'synthetic-project','chats','session-synthetic.jsonl');await jsonl(path,records);
 const ids=[];for await(const identity of geminiAdapter().identify(root))ids.push(identity);
 assert.equal(ids.length,1);const expectedId=geminiReplay(records).metadata['sessionId'];
 assert.equal(ids[0]!.id,expectedId);
 const s=await geminiAdapter().analyze(ids[0]!,context);assert.equal(s!.sessionKey,createHash('sha256').update(`gemini:${expectedId}`).digest('hex').slice(0,12));
}));

test('ADAPTER-003: Copilot context is optional in the official session.start schema',async()=>fixture(async root=>{
 await jsonl(join(root,'synthetic-session','events.jsonl'),[{id:'event-start',type:'session.start',timestamp:at,data:{sessionId:'synthetic-session',startTime:at,version:1,producer:'copilot-agent',copilotVersion:'synthetic'}},{id:'event-user',type:'user.message',timestamp:at,data:{content:sentinel}}]);
 const ids=[];for await(const id of copilotAdapter.identify(root))ids.push(id);
 assert.equal(ids.length,1);assert.equal(ids[0]!.cwd,null);
 const s=await copilotAdapter.analyze(ids[0]!,context);assert.equal(s!.metrics.userTurns,1);assert.ok(!JSON.stringify(s).includes(sentinel));
}));

for(const damaged of ['message','part'])test(`ADAPTER-004: OpenCode ${damaged} parse failure makes accounting partial`,async()=>fixture(async root=>{
 const path=join(root,'synthetic.db');const db=new DatabaseSync(path);
 db.exec('CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,directory TEXT,time_created INTEGER,time_updated INTEGER);CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT);CREATE TABLE part(id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT)');
 db.prepare('INSERT INTO session VALUES(?,NULL,?,?,?)').run('synthetic-session',root,Date.parse(at),Date.parse(at));
 db.prepare('INSERT INTO message VALUES(?,?,?)').run('message','synthetic-session',JSON.stringify({role:'assistant',modelID:'synthetic-model',time:{created:Date.parse(at)},tokens:{input:100,output:20}}));
 if(damaged==='message')db.prepare('INSERT INTO message VALUES(?,?,?)').run('broken','synthetic-session','{bad');
 else db.prepare('INSERT INTO part VALUES(?,?,?,?,?)').run('broken','synthetic-session','message',Date.parse(at),'{bad');
 db.close();const ids=[];for await(const id of opencodeAdapter.identify(path))ids.push(id);
 const s=await opencodeAdapter.analyze(ids[0]!,context);assert.equal(s!.tokens.inputTokens,100);assert.equal(s!.costComplete,false);assert.equal(s!.evidence!.accounting,'partial');
}));

test('verified: Gemini official token classes and content-only patches match the independent oracle',async()=>fixture(async root=>{
 const records=[header,assistant,{$patch:{id:'a',content:sentinel,tokens:{input:999}}},{$set:{lastUpdated:at}}];
 const expected=geminiCounters(records);const s=await analyzeGemini(root,records);
 assert.equal(s.tokens.inputTokens,expected.input);assert.equal(s.tokens.cachedInputTokens,expected.cacheRead);assert.equal(s.tokens.outputTokens,expected.output);assert.equal(s.tokens.reasoningOutputTokens,expected.reasoning);
}));

test('verified: independent OpenCode per-step counters exclude the final assistant snapshot',()=>{
 const message={id:'m',role:'assistant',tokens:{input:20,output:3,reasoning:1,cache:{read:5,write:2}}};
 const parts=[{message_id:'m',type:'step-finish',tokens:{input:10,output:2,reasoning:1,cache:{read:4,write:1}}},{message_id:'m',type:'step-finish',tokens:message.tokens}];
 assert.deepEqual(openCodeCounters([message],parts),{input:42,cacheRead:9,cacheWrite:3,output:5,reasoning:2,userTurns:0,assistantMessages:1,toolCalls:0,requests:2});
});

test('verified: independent Copilot activity oracle deduplicates persisted IDs and excludes usage money assumptions',()=>{
 const event={id:'e',type:'assistant.message',data:{messageId:'m'}};
 assert.deepEqual(copilotCounters([event,event,{...event,id:'other'},{id:'usage',type:'assistant.usage',ephemeral:true,data:{inputTokens:999}}]),{userTurns:0,assistantMessages:1,toolCalls:0,compactions:0});
});


test('ADAPTER-005: one oversized Gemini file does not suppress later valid sessions',async()=>fixture(async root=>{
 const chats=join(root,'synthetic-project','chats');await mkdir(chats,{recursive:true});
 await writeFile(join(chats,'session-a-oversized.json'),' '.repeat(4*1024*1024+1));
 await writeFile(join(chats,'session-z-valid.json'),JSON.stringify({...header,messages:[assistant]}));
 const result=await additionalProviderSessions({home:root,options:{additionalProviders:false,geminiRoot:root},environment:{},knownPaths:[],existingSessions:[],pricing:context,repositoryForSession:async()=>context.repository});
 assert.equal(result.sessions.length,1);assert.equal(result.sessions[0]!.tokens.inputTokens,100);assert.ok(result.warnings.length>0);
}));
