import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { cursorSdkAdapter } from '../../src/providers/cursor-sdk.ts';
import { normalizeSource } from '../../src/pricing/sources.ts';
import { catalogFromSnapshots, resolveRate } from '../../src/pricing/catalog.ts';
import { validateSnapshot } from '../../src/interop/snapshot.ts';
import { approvedWarning } from '../../src/public/evidence.js';
import { findModelRate } from '../../src/pricing/aliases.ts';
import { priceUsage } from '../../src/pricing/usage.ts';
import { analyzeMachineSessions } from '../../src/analyzer.ts';
import { createSessionAnalyticsFixture } from '../fixtures.ts';
import type { ProviderContext } from '../../src/providers/adapter.ts';

const at='2026-09-01T10:00:00.000Z',end='2026-09-01T10:01:00.000Z';
const id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const sha=(v:string)=>createHash('sha256').update(v).digest('hex').slice(0,12);
const sentinel='SYNTHETIC_PRIVATE_CONTENT_DO_NOT_EXPORT';
async function fixture(fn:(root:string)=>Promise<void>) {const root=await mkdtemp(join(tmpdir(),'validation-sdk-'));try{await fn(root)}finally{await rm(root,{recursive:true,force:true})}}
async function writeStore(root:string,cwd:string, options:{malformed?:boolean;usage?:boolean;eventUsage?:boolean;input?:number}={}) {
 await mkdir(root,{recursive:true});
 const usage={inputTokens:options.input??100,cacheReadTokens:40,cacheWriteTokens:0,outputTokens:30,reasoningTokens:10,totalTokens:(options.input??100)+70};
 await writeFile(join(root,'agents.ndjson'),JSON.stringify({agentId:id,cwd,createdAt:at,updatedAt:end,name:sentinel})+'\n');
 await writeFile(join(root,'runs.ndjson'),JSON.stringify({agentId:id,runId:'synthetic-run',model:{id:'grok-4.6'},status:'finished',createdAt:at,startedAt:at,endedAt:end,updatedAt:end,usage:options.usage===false?null:usage,result:sentinel})+'\n');
 const events=options.eventUsage?[{runId:'synthetic-run',seq:1,createdAt:end,payload:{type:'sdk_message',message:{type:'usage',run_id:'synthetic-run',agent_id:id,usage}}}]:[];
 await writeFile(join(root,'run_events.ndjson'),events.map(e=>JSON.stringify(e)+'\n').join('')+(options.malformed?'{bad-json\n':''));
}
function context():ProviderContext {
 return {repository:{id:'synthetic',name:'Synthetic'},rateCard:{currency:'USD',effectiveDate:'2026-09-01',models:{'grok-4.6':{provider:'cursor',source:'https://docs.x.ai/developers/models/grok-4.6',inputPerMillion:2,cacheReadPerMillion:.5,outputPerMillion:6,contextTiers:[{aboveInputTokens:200000,inputPerMillion:4,cacheReadPerMillion:1,outputPerMillion:12}]}}},price:(r,u,i)=>priceUsage(r,u,i).cost};
}
async function analyze(root:string,c=context()) {for await(const ident of cursorSdkAdapter.identify(root)){const s=await cursorSdkAdapter.analyze(ident,c);assert.ok(s);assert.ok(!JSON.stringify(s).includes(sentinel));return s}throw new Error('Synthetic session absent')}

test('CURSOR-01 models.dev retains direct xAI Grok prices',()=>{
 const result=normalizeSource('models.dev',{openai:{models:{'gpt-5':{cost:{input:1,output:2}}}},xai:{models:{'grok-4.6':{cost:{input:2,cache_read:.5,output:6}},'grok-4.7':{cost:{input:2,cache_read:.5,output:6}}}}});
 assert.equal(result.models['grok-4.6']?.cacheReadPerMillion,.5);assert.equal(result.models['grok-4.7']?.inputPerMillion,2);
});
test('CURSOR-01 LiteLLM xai namespace resolves the recorded direct model ID',()=>{
 const result=normalizeSource('litellm',{'gpt-5':{litellm_provider:'openai',input_cost_per_token:.000001,output_cost_per_token:.000002},'xai/grok-4.6':{litellm_provider:'xai',input_cost_per_token:.000002,cache_read_input_token_cost:.0000005,output_cost_per_token:.000006}});
 assert.equal(findModelRate(result.models,'grok-4.6')?.rate.cacheReadPerMillion,.5);
});
test('CURSOR-02 SDK sessions registered in Conductor use the documented session key',async()=>fixture(async root=>{
 const f=await createSessionAnalyticsFixture(root),sdk=join(root,'sdk');await writeStore(sdk,f.repositoryRoot);
 const db=new DatabaseSync(f.databasePath);const w=db.prepare('SELECT workspace_id FROM sessions LIMIT 1').get()!;
 db.prepare('INSERT INTO sessions (id,agent_type,status,created_at,updated_at,workspace_id,claude_session_id) VALUES (?,?,?,?,?,?,?)').run('synthetic-conductor-cursor','cursor','completed',at,end,w['workspace_id']!,id);db.close();
 const result=await analyzeMachineSessions({noIndex:true,additionalProviders:false,pricingPolicy:'reviewed-only',dataDir:join(root,'derived'),databasePath:f.databasePath,claudeRoot:f.claudeRoot,codexRoot:f.codexRoot,codexArchiveRoot:f.codexArchiveRoot,cursorDatabasePath:f.cursorDatabasePath,cursorSdkRoot:sdk});
 validateSnapshot(result);
 const actual=result.sessions.find(s=>s.evidence?.source==='cursor-sdk');assert.ok(actual);assert.equal(actual.sessionKey,sha('synthetic-conductor-cursor'));
}));
test('CURSOR-03 SDK aggregate upper price allows every configured context tier',async()=>fixture(async root=>{
 await writeStore(root,root,{input:300000});const s=await analyze(root);
 assert.ok(Math.abs(s.cost.totalUsd-.6002)<1e-12);assert.ok(Math.abs(s.cost.upperEstimateUsd-1.2004)<1e-12);
}));
test('CURSOR-04 SDK pricing retains the run timestamp independently of daily allocation',async()=>fixture(async root=>{
 await writeStore(root,root);const c=context();
 const oldRate=c.rateCard.models['grok-4.6']!,newRate={...oldRate,inputPerMillion:4,cacheReadPerMillion:1,outputPerMillion:12};
 const catalog=catalogFromSnapshots({version:1,source:'reviewed',fetchedAt:'2026-09-01T00:00:00Z',payloadSha256:'a'.repeat(64),card:{currency:'USD',effectiveDate:'2026-09-01',models:{}}},[
  {version:1,source:'models.dev',sourceUrl:'https://models.dev/api.json',fetchedAt:'2026-09-01T00:00:00Z',payloadSha256:'b'.repeat(64),models:{'grok-4.6':oldRate},rejectedModels:0},
  {version:1,source:'models.dev',sourceUrl:'https://models.dev/api.json',fetchedAt:'2026-09-02T00:00:00Z',payloadSha256:'c'.repeat(64),models:{'grok-4.6':newRate},rejectedModels:0}
 ],{pricingPolicy:'api-first',pricingSources:['models.dev']},new Date('2026-09-03T00:00:00Z'));
 c.resolveRate=(model,time)=>resolveRate(catalog,model,time);const s=await analyze(root,c);
 assert.equal(s.cost.totalUsd,.0004);assert.equal(s.models[0]?.pricing?.[0]?.temporal,'at-or-before');assert.deepEqual(s.spendByDay,{});
}));
test('CURSOR-05 SDK usage events recover a terminal run with no summary counters',async()=>fixture(async root=>{
 await writeStore(root,root,{usage:false,eventUsage:true});const s=await analyze(root);
 assert.equal(s.tokens.inputTokens,140);assert.equal(s.tokens.outputTokens,30);assert.equal(s.evidence?.accounting,'partial');assert.equal(s.costComplete,false);assert.ok(s.transcript.warnings.every(approvedWarning));
}));
test('CURSOR-06 malformed SDK tool events cannot claim complete observed tools',async()=>fixture(async root=>{
 await writeStore(root,root,{malformed:true});const s=await analyze(root);
 assert.ok(s.transcript.warnings.some(w=>/Malformed Cursor SDK records/.test(w)));
}));

test('CURSOR-05 recovery deduplicates event sequence IDs and remains partial for broken live streams',async()=>fixture(async root=>{
 await writeStore(root,root,{usage:false,eventUsage:true});
 const {readFile}=await import('node:fs/promises');
 const row=JSON.parse(await readFile(join(root,'runs.ndjson'),'utf8'));row.status='running';row.endedAt=null;await writeFile(join(root,'runs.ndjson'),JSON.stringify(row)+'\n');
 const events=await readFile(join(root,'run_events.ndjson'),'utf8');await writeFile(join(root,'run_events.ndjson'),events+events+'{truncated\n');
 const s=await analyze(root);assert.equal(s.tokens.inputTokens,140);assert.equal(s.evidence?.accounting,'partial');assert.equal(s.costComplete,false);
}));
test('CURSOR-05 canonical run summaries take precedence over event recovery',async()=>fixture(async root=>{
 await writeStore(root,root,{eventUsage:true});const s=await analyze(root);assert.equal(s.tokens.inputTokens,140);assert.notEqual(s.evidence?.accounting,'partial');
}));
