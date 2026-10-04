import './safe-failures.mjs';
/** Independent browser oracle. Written from snapshot schema and docs before reading UI implementation.
 * Reads private snapshot in memory; output contains only counters, model IDs, enums and dates.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export const counters = ['valueUsd','inputTokens','uncachedInputTokens','cachedInputTokens','cacheWriteInputTokens','outputTokens','reasoningOutputTokens','modelCalls','toolCalls','sessionsStarted','pricedTokens','reasoningKnownOutputTokens','cacheReadKnownInputTokens','cacheWriteKnownInputTokens'];
export const windows = ['7d','30d','90d','all','custom'];
export const providers = ['all','claude','codex','cursor','copilot','opencode','gemini','unsupported'];
export function bounds(snapshot, window, custom = {start:'2026-09-01',end:'2026-09-30'}) {
 const end = snapshot.generatedAt.slice(0,10); // Freeze UI clock to snapshot so cohort is reproducible.
 if(window==='all')return {start:null,end:null};
 if(window==='custom')return custom;
 const d=new Date(`${end}T00:00:00Z`); d.setUTCDate(d.getUTCDate()-Number.parseInt(window)+1);
 return {start:d.toISOString().slice(0,10),end};
}
export function select(snapshot, window='all', provider='all', custom) {
 const range=bounds(snapshot,window,custom);
 return snapshot.sessions.filter(s=>{
  if(provider!=='all'&&s.provider!==provider)return false;
  if(window==='all')return true;
  if(s.transcript?.startTimeKnown===false||s.evidence?.timing==='file-mtime')return false;
  const date=s.createdAt??s.firstEventAt; if(!date||!Number.isFinite(Date.parse(date)))return false;
  const day=new Date(date).toISOString().slice(0,10);
  return day>=range.start&&day<=range.end;
 });
}
export function aggregate(sessions) {
 const sums={sessions:sessions.length,analyzedSessions:0,apiEquivalentSpendUsd:0,providerReportedSpendUsd:0,estimatedSpendUsd:0,estimatedUpperSpendUsd:0,inputTokens:0,outputTokens:0,cachedInputTokens:0,toolCalls:0,compactions:0,modelCalls:0,userTurns:0,pricedTokens:0,eligibleTokens:0,topLevelSessions:0,subagentSessions:0,topLevelSpendUsd:0,subagentSpendUsd:0,unknownSpendUsd:0,workingSnapshots:0,unpricedSessions:0};
 const models=new Map(),days=new Map(),repoSet=new Set();
 for(const s of sessions){
  repoSet.add(s.repositoryId); sums.analyzedSessions+=s.transcript?.status==='ok'?1:0;
  sums.estimatedSpendUsd+=s.cost.totalUsd; sums.estimatedUpperSpendUsd+=s.cost.upperEstimateUsd;
  if(s.costBasis==='provider-reported')sums.providerReportedSpendUsd+=s.cost.totalUsd;
  if(s.costBasis==='api-list-price-equivalent')sums.apiEquivalentSpendUsd+=s.cost.totalUsd;
  for(const k of ['inputTokens','outputTokens','cachedInputTokens'])sums[k]+=s.tokens[k]??0;
  for(const k of ['toolCalls','compactions','modelCalls','userTurns'])sums[k]+=s.metrics[k]??0;
  sums.topLevelSessions+=['top-level','mixed'].includes(s.executionKind)?1:0;sums.subagentSessions+=['subagent','mixed'].includes(s.executionKind)?1:0;
  sums.topLevelSpendUsd+=s.costByExecution?.topLevelUsd??0;sums.subagentSpendUsd+=s.costByExecution?.subagentUsd??0;sums.unknownSpendUsd+=s.costByExecution?.unknownUsd??0;
  sums.workingSnapshots+=s.transcript?.snapshotWhileWorking?1:0;sums.unpricedSessions+=s.costBasis==='api-list-price-equivalent'&&!s.costComplete?1:0;
  for(const m of s.models){
   sums.pricedTokens+=m.pricingCoverage?.pricedTokens??0;sums.eligibleTokens+=m.pricingCoverage?.eligibleTokens??0;
   const modelKey=`${s.provider}:${m.model}`;
   const row=models.get(modelKey)??{provider:s.provider,model:m.model,calls:0,inputTokens:0,outputTokens:0,apiEquivalentSpendUsd:0,providerReportedSpendUsd:0,totalUsd:0};
   for(const k of ['calls','inputTokens','outputTokens','totalUsd'])row[k]+=m[k]??0;
   if(s.costBasis==='api-list-price-equivalent')row.apiEquivalentSpendUsd+=m.totalUsd;
   if(s.costBasis==='provider-reported')row.providerReportedSpendUsd+=m.totalUsd;
   models.set(modelKey,row);
  }
  for(const [day,value] of Object.entries(s.spendByDay??{}))days.set(day,(days.get(day)??0)+value);
 }
 return {...sums,repositories:repoSet.size,cacheReadRatio:sums.inputTokens?sums.cachedInputTokens/sums.inputTokens:null,pricedTokenCoverage:sums.eligibleTokens?sums.pricedTokens/sums.eligibleTokens:null,models:[...models.values()].sort((a,b)=>b.totalUsd-a.totalUsd),days:[...days].sort().map(([day,value])=>({day,value}))};
}
export function velocity(snapshot,window,provider,custom){
 const range=bounds(snapshot,window,custom), totals=Array(14).fill(0), undated=Array(14).fill(0),days=new Map(),models=new Map();let providerReportedExcluded=0;
 for(const s of snapshot.sessions){
  if(provider!=='all'&&s.provider!==provider)continue;
  if(s.costBasis==='provider-reported')providerReportedExcluded+=s.cost.totalUsd;
  for(const [day,hour,dimension,values] of s.velocity?.buckets??[]){
   if(range.start&&(day<range.start||day>range.end))continue;
   const d=days.get(day)??Array(14).fill(0), model=s.velocity.dimensions[dimension].model,m=models.get(model)??Array(14).fill(0);
   values.forEach((v,i)=>{totals[i]+=v;d[i]+=v;m[i]+=v;}); days.set(day,d);models.set(model,m);
  }
  for(const [,values] of s.velocity?.undated??[])values.forEach((v,i)=>undated[i]+=v);
 }
 const obj=values=>Object.fromEntries(counters.map((k,i)=>[k,values[i]]));
 return {totals:obj(totals),undated:obj(undated),providerReportedExcluded,days:[...days].sort().map(([day,v])=>({day,...obj(v)})),models:[...models].map(([model,v])=>({model,...obj(v)})).sort((a,b)=>b.valueUsd-a.valueUsd)};
}
export function matrix(snapshot){return windows.flatMap(window=>providers.map(provider=>({window,provider,bounds:bounds(snapshot,window),cohort:aggregate(select(snapshot,window,provider)),activity:velocity(snapshot,window,provider)})));}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const snapshot=JSON.parse(readFileSync(process.argv[2]??new URL('../../../reference/snapshot-noindex-51ea561.json', import.meta.url),'utf8'));
 const result={generatedAt:snapshot.generatedAt,oracleBasis:'Independent session-start cohorts and activity-date velocity; UTC; inclusive dates; no frontend imports',matrix:matrix(snapshot)};
 writeFileSync(process.argv[3]??'.lane/browser-oracle.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({scenarios:result.matrix.length,all:aggregate(snapshot.sessions).sessions}));
}

/** Dimension totals use the ledger's recorded dimensions, without browser grouping helpers. */
export function velocityGroups(snapshot,window,provider,group){
 const range=bounds(snapshot,window),rows=new Map();
 for(const session of snapshot.sessions){if(provider!=='all'&&session.provider!==provider)continue;
  for(const [day,,index,values]of session.velocity?.buckets??[]){if(range.start&&(day<range.start||day>range.end))continue;
   const dim=session.velocity.dimensions[index];const key=group==='provider'?session.provider:group==='model'?`${session.provider}:${dim.model}`:group==='execution'?dim.executionKind:group==='effort'?dim.effort:dim.agent;
   rows.set(key,(rows.get(key)??0)+values[0]);
  }
 }
 let result=[...rows].filter(([,total])=>total>0).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
 if(group==='model'&&result.length>7)result=[...result.slice(0,7),['other',result.slice(7).reduce((a,[,v])=>a+v,0)]];
 return result;
}
