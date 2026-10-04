/** Independent raw-store oracle. No imports from src, no raw IDs/paths/content in output. */
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from '../shared/sqlite.ts';
import { absentPriceEvidence } from './price-evidence.ts';
import { compareUnavailableCursorTime } from './time-scope.ts';
try {
const hash = (v: string) => createHash('sha256').update(v).digest('hex').slice(0,12);
const base = join(homedir(),'Library/Application Support/com.conductor.app');
const snapshot = JSON.parse(await readFile(process.argv[2] ?? join(homedir(),'session-analytics-lanes/reference/snapshot-noindex-51ea561.json'),'utf8'));
const cutoff = Date.parse(snapshot.generatedAt);
const priceEvidence = await absentPriceEvidence(['grok-4.6','grok-4.7']);
const counts: Record<string,number> = {};
const count = (k:string,n=1) => counts[k]=(counts[k]??0)+n;
const agents = new Map<string,any>(); const runs = new Map<string,any>(); const events: any[]=[];
const date = (v:any) => typeof v==='number' ? v : Date.parse(v);
const baseUsd=(m:any)=>(2*m.input+.5*m.cacheRead+6*m.output)/1e6;
async function walk(root:string) {
 for(const ent of await readdir(root,{withFileTypes:true}).catch((error)=>{if(error.code==='ENOENT'){count('missingDirectories');return [];}count('unreadableDirectories');throw new Error('unreadable');})) {
  const path=join(root,ent.name);
  if(ent.isDirectory()) { await walk(path); continue; }
  if(!['agents.ndjson','runs.ndjson','run_events.ndjson'].includes(ent.name)) continue;
  count('files.'+ent.name);
  for(const line of (await readFile(path,'utf8')).split('\n')) {
   if(!line.trim())continue;
   let r:any;try{r=JSON.parse(line)}catch{count('malformed');continue}
   count('rows.'+ent.name);
   if(ent.name==='agents.ndjson') {
    const p={id:r.agentId,cwd:r.cwd,created:date(r.createdAt),updated:date(r.updatedAt)};
    if(agents.has(p.id))count('duplicateAgentSnapshots');
    if(!agents.has(p.id)||agents.get(p.id).updated<=p.updated) agents.set(p.id,p);
   } else if(ent.name==='runs.ndjson') {
    const p={id:r.runId,agentId:r.agentId,model:['grok-4.6','grok-4.7'].includes(r.model?.id)?r.model.id:'<unknown>',status:r.status,fast:r.model?.params?.find((p:any)=>p.id==='fast')?.value==='true',usage:r.usage?Object.fromEntries(['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','totalTokens','reasoningTokens'].map(k=>[k,typeof r.usage[k]==='number'?r.usage[k]:0])):null,created:date(r.createdAt),updated:date(r.updatedAt),started:date(r.startedAt),ended:date(r.endedAt)};
    if(runs.has(p.id)){count('duplicateRunSnapshots');if(runs.get(p.id).agentId!==p.agentId)throw new Error('ambiguous-run');}
    if(!runs.has(p.id)||runs.get(p.id).updated<=p.updated) runs.set(p.id,p);
   } else {
    const m=r.payload?.message;
    if(m?.type==='tool_call') events.push({run:r.runId,agent:m.agent_id,call:m.call_id,type:'tool_call',at:date(r.createdAt)});
    if(m?.type==='usage'&&['request_id','requestId','response_id','responseId'].some(key=>typeof m[key]==='string'))count('perRequestBillingIdentities');
    if(m?.type==='usage') events.push({run:r.runId,agent:m.agent_id,seq:r.seq,type:'usage',at:date(r.createdAt),usage:Object.fromEntries(['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','totalTokens','reasoningTokens'].map(k=>[k,typeof m.usage?.[k]==='number'?m.usage[k]:0]))});
   }
  }
 }
}
await walk(join(base,'cursor-sdk-store'));
if([...runs.values()].some(r=>r.model==='<unknown>')) throw new Error('An unreviewed model requires oracle pricing review.');
const db=new DatabaseSync(join(base,'conductor.db'),{readOnly:true});
const registrations=db.prepare("SELECT s.id,s.claude_session_id,s.created_at,s.updated_at,s.status,s.workspace_id,w.repository_id FROM sessions s LEFT JOIN workspaces w ON w.id=s.workspace_id WHERE s.agent_type='cursor'").all() as any[];
const repositoryPaths=db.prepare("SELECT id,root_path AS path FROM repos UNION SELECT repository_id AS id,workspace_path AS path FROM workspaces").all() as any[];
db.close();
const registration=new Map(registrations.filter(r=>r.claude_session_id).map(r=>[r.claude_session_id,r]));
const reference=new Map(snapshot.sessions.filter((s:any)=>s.provider==='cursor').map((s:any)=>[s.sessionKey,s]));
const sessions:any[]=[];const excluded:any[]=[];
for(const a of agents.values()) {
 const ar=[...runs.values()].filter(r=>r.agentId===a.id);
 if(a.updated>cutoff||ar.some(r=>r.updated>cutoff||r.ended>cutoff)||events.some(e=>e.agent===a.id&&e.at>cutoff)){excluded.push({sessionKey:hash('cursor:'+a.id),reason:'after-cutoff'});continue;}
 const reg=registration.get(a.id);
 const paths=repositoryPaths.filter(r=>typeof r.path==='string'&&r.path.length>1&&(a.cwd===r.path||a.cwd.startsWith(r.path.replace(/\/$/,'')+'/'))).sort((a,b)=>b.path.length-a.path.length);
 const longest=paths.filter(p=>p.path.length===paths[0]?.path.length);
 const repoIds=[...new Set(longest.map(p=>p.id))];
 const expectedRepoId=reg?.repository_id??(repoIds.length===1?repoIds[0]:null);
 const expectedRepositoryKey=expectedRepoId?hash('conductor-'+createHash('sha256').update('conductor:'+expectedRepoId).digest('hex').slice(0,20)):null;
 const key=hash(reg?reg.id:'cursor:'+a.id);
 const models:Record<string,any>={};const tools=new Set<string>();
 for(const r of ar) {
  const u=r.usage;
  if(!u){count('runsWithoutUsage');continue}
  count('runsWithUsage');
  if(u.totalTokens!==u.inputTokens+u.outputTokens+u.cacheReadTokens+u.cacheWriteTokens)count('nonadditiveUsage');
  if(u.reasoningTokens>u.outputTokens)count('reasoningExceedsOutput');
  const mo=models[r.model]??={model:r.model,runs:0,input:0,cacheRead:0,cacheWrite:0,output:0,reasoning:0,total:0,apiUpperUsd:0};
  mo.runs++;mo.input+=u.inputTokens;mo.cacheRead+=u.cacheReadTokens;mo.cacheWrite+=u.cacheWriteTokens;mo.output+=u.outputTokens;mo.reasoning+=u.reasoningTokens;mo.total+=u.totalTokens;mo.apiUpperUsd+=(2*u.inputTokens+.5*u.cacheReadTokens+6*u.outputTokens)/1e6*((u.inputTokens+u.cacheReadTokens+u.cacheWriteTokens)>200000?2:1);
  const seenUsage=new Set();const ue=events.filter(e=>{if(e.type!=='usage'||e.run!==r.id||e.agent!==r.agentId)return false;const key=e.seq;if(seenUsage.has(key)){count('duplicateUsageEvents');return false;}seenUsage.add(key);return true;});
  if(ue.length===0)count('runsWithoutUsageEvent');
  else {
   const sums=Object.fromEntries(Object.keys(u).map(k=>[k,ue.reduce((s,e)=>s+e.usage[k],0)]));
   if(JSON.stringify(sums)!==JSON.stringify(u))count('runVsSummedUsageEventsMismatch');
   if(ue.length>1)count('runsWithMultipleUsageEvents');
  }
 }
 for(const e of events)if(e.type==='tool_call'&&ar.some(r=>r.id===e.run)) tools.add(e.run+':'+e.call);
 const nativeKey=hash('cursor:'+a.id);
 const ref:any=reference.get(key)??reference.get(nativeKey);
 const ms:any[]=Object.values(models);
 for(const m of ms){m.apiBaseUsd=baseUsd(m);}
 const pricedRuns=ar.filter(r=>r.usage).map(r=>({model:r.model,fast:r.fast,...r.usage,base:(2*r.usage.inputTokens+.5*r.usage.cacheReadTokens+6*r.usage.outputTokens)/1e6}));
 const cursorTierBaseUsd=pricedRuns.reduce((s,r)=>s+r.base*(r.fast?2:1),0);
 const cursorTierUpperUsd=pricedRuns.reduce((s,r)=>s+r.base*(r.model==='grok-4.7'&&(r.inputTokens+r.cacheReadTokens+r.cacheWriteTokens)>256000?(r.fast?3:2):(r.fast?2:1)),0);
 const input=ms.reduce((s,m)=>s+m.input+m.cacheRead+m.cacheWrite,0),output=ms.reduce((s,m)=>s+m.output,0);
 sessions.push({expectedRepositoryKey,sessionKey:key,referenceSessionKey:ref?.sessionKey??null,nativeSessionKey:nativeKey,registered:!!reg,registeredRepositoryKey:reg?hash('conductor-'+createHash('sha256').update('conductor:'+reg.repository_id).digest('hex').slice(0,20)):null,month:new Date(a.created).toISOString().slice(0,7),apiBaseUsd:ms.reduce((s,m)=>s+m.apiBaseUsd,0),apiUpperUsd:ms.reduce((s,m)=>s+m.apiUpperUsd,0),cursorTierBaseUsd,cursorTierUpperUsd,fastUsageRuns:pricedRuns.filter(r=>r.fast).length,runs:ar.length,startedRuns:ar.filter(r=>Number.isFinite(r.started)).length,usageRuns:ms.reduce((s,m)=>s+m.runs,0),input,output,toolCalls:tools.size,models:ms,reference:ref?{sessionKey:ref.sessionKey,velocity:ref.velocity,spendByDay:ref.spendByDay,input:ref.tokens.inputTokens,output:ref.tokens.outputTokens,usd:ref.cost.totalUsd,cost:ref.cost,costBasis:ref.costBasis,costComplete:ref.costComplete,pricedTokenCoverage:ref.pricedTokenCoverage,models:ref.models,metrics:ref.metrics,evidence:ref.evidence,transcript:ref.transcript.status,repositoryKey:hash(ref.repositoryId)}:null});
}
const aggregate = (key:(s:any)=>string) => { const groups:Record<string,any>={}; for(const s of sessions){const k=key(s),g=groups[k]??={sessions:0,usageSessions:0,input:0,output:0,referenceInput:0,referenceOutput:0,referenceUsd:0,apiBaseUsd:0,apiUpperUsd:0,cursorTierBaseUsd:0,cursorTierUpperUsd:0};g.sessions++;g.usageSessions+=Number(s.usageRuns>0); for(const n of ['input','output','apiBaseUsd','apiUpperUsd','cursorTierBaseUsd','cursorTierUpperUsd'])g[n]+=s[n];g.referenceInput+=s.reference?.input??0;g.referenceOutput+=s.reference?.output??0;g.referenceUsd+=s.reference?.usd??0;}return groups;};
const byModel:Record<string,any>={};for(const s of sessions)for(const m of s.models){const g=byModel[m.model]??={sessions:0,runs:0,input:0,cacheRead:0,cacheWrite:0,output:0,reasoning:0,total:0,apiBaseUsd:0,apiUpperUsd:0};g.sessions++;for(const n of Object.keys(g).filter(k=>k!=='sessions'))g[n]+=m[n];}
const modelDifferences:any[]=[];for(const s of sessions)for(const m of s.models){const actual=s.reference?.models.find((r:any)=>r.model===m.model);for(const [raw,field] of [['input','uncachedInputTokens'],['cacheRead','cachedInputTokens'],['cacheWrite','cacheWriteInputTokens'],['output','outputTokens'],['reasoning','reasoningOutputTokens']])if(m[raw]!==actual?.[field])modelDifferences.push({sessionKey:s.referenceSessionKey,model:m.model,field,oracle:m[raw],reference:actual?.[field]??null});}
const unpricedEvidence:any[]=[];
for(const s of sessions) {
 if(!s.models.every((m:any)=>priceEvidence.missingModels.includes(m.model)))continue;
 const ref=s.reference, fields:string[]=[];
 if(!ref)continue; // Missing session is already a separate exact gate.
 if(Object.values(ref.cost).some(value=>value!==0))fields.push('cost');
 if(ref.costComplete!==false)fields.push('costComplete');
 if(ref.costBasis!=='unavailable')fields.push('costBasis');
 if(ref.pricedTokenCoverage!==(s.input+s.output>0?0:null))fields.push('pricedTokenCoverage');
 for(const m of s.models){const actual=ref.models.find((r:any)=>r.model===m.model);if(!actual)continue;
  if(actual.priced!==false||(actual.pricing??[]).length!==0||actual.pricingCoverage?.pricedTokens!==0||actual.pricingCoverage?.eligibleTokens!==m.input+m.cacheRead+m.cacheWrite+m.output)fields.push('modelCoverage');
 }
 if(fields.length)unpricedEvidence.push({sessionKey:s.sessionKey,fields:[...new Set(fields)]});
}
const represented=new Set(sessions.map(s=>s.referenceSessionKey));
const referenceOnlySdk=[...reference.values()].filter((s:any)=>s.evidence?.source==='cursor-sdk'&&!represented.has(s.sessionKey)).map((s:any)=>s.sessionKey);
const timeInventory={granularity:'run-summary',knownRunEnvelopeTimestamps:[...runs.values()].filter(r=>Number.isFinite(r.started)||Number.isFinite(r.ended)).length,retainedUsageEvents:events.filter(e=>e.type==='usage').length,perRequestBillingIdentities:counts['perRequestBillingIdentities']??0,requestCallsObserved:false,datedAccountingSupported:false};
const timeFields=sessions.flatMap(s=>s.reference?compareUnavailableCursorTime(s.reference,'run-summary',timeInventory):[]);
const differences={timeFields,unpricedEvidence,unpricedEvidenceSessions:unpricedEvidence.length,modelFields:modelDifferences,referenceOnlySdk,independentlyMappedRepositories:sessions.filter(s=>s.expectedRepositoryKey).length,repositorySessions:sessions.filter(s=>s.expectedRepositoryKey&&s.expectedRepositoryKey!==s.reference?.repositoryKey).length,tokenSessions:sessions.filter(s=>s.reference&&(s.input!==s.reference.input||s.output!==s.reference.output)).length,toolSessions:sessions.filter(s=>s.reference&&s.toolCalls!==s.reference.metrics.toolCalls).length,turnSessions:sessions.filter(s=>s.reference&&s.startedRuns!==s.reference.metrics.userTurns).length,keySessions:sessions.filter(s=>s.sessionKey!==s.referenceSessionKey).length,missingSessions:sessions.filter(s=>!s.reference).length,registeredRepositorySessions:sessions.filter(s=>s.registered&&s.registeredRepositoryKey!==s.reference?.repositoryKey).length};
console.log(JSON.stringify({byProvider:aggregate(()=>'cursor'),byMonth:aggregate(s=>s.month),byRepository:aggregate(s=>s.reference?.repositoryKey??'unassigned'),byModel,differences,priceEvidence,oracle:'cursor-sdk-independent-v1',cutoff:snapshot.generatedAt,timeInventory,counts,uniqueAgents:agents.size,uniqueRuns:runs.size,registeredSessions:registrations.length,referenceCursorSessions:reference.size,excluded,sessions},null,2));

} catch { console.error(JSON.stringify({oracle:'cursor-sdk-independent-v1',error:'Required evidence could not be read or validated.'})); process.exitCode=1; }
