/** Compare previously generated, source-independent oracle with frozen reference. */
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import { runPrivate, safeTimestamp, safeModel, safeCount, safeHash, safeRepositoryKey } from './codex-safe.mjs';

await runPrivate(async () => {
const raw=JSON.parse(readFileSync('.lane/codex-raw-oracle.json','utf8'));
const ref=JSON.parse(readFileSync(join(homedir(),'session-analytics-lanes/reference/snapshot-noindex-51ea561.json'),'utf8'));
const sessions=ref.sessions.filter(r=>r.provider==='codex');
// Null-provider-ID Conductor recovery has no direct raw-ID key mapping. Resolve
// only unique matches with identical first/last timestamps and token operands.
const knownKeys=new Set(sessions.map(s=>s.sessionKey)),aliases=[];
for(const f of raw.fileRows.filter(f=>!f.afterCutoff&&!knownKeys.has(f.sessionKey))){
 const matches=sessions.filter(s=>s.firstEventAt===f.firstAt&&s.lastEventAt===f.lastAt&&s.tokens.inputTokens===f.rawLastUsage.input&&s.tokens.outputTokens===f.rawLastUsage.output);
 if(matches.length===1){aliases.push({providerSessionKey:f.sessionKey,referenceSessionKey:matches[0].sessionKey,method:'unique first/last timestamp and physical-token match'});const old=f.sessionKey;for(const rows of [raw.fileRows,raw.dbRows,raw.historySessions])for(const r of rows)if(r.sessionKey===old)r.sessionKey=matches[0].sessionKey;}
}
const cutoffMs=Date.parse(ref.generatedAt);
const activeKeys=new Set([...raw.fileRows,...raw.dbRows].filter(r=>r.afterCutoff).flatMap(r=>[r.sessionKey,r.providerKey]));
for(const s of sessions)if(Date.parse(s.lastEventAt)>cutoffMs)activeKeys.add(s.sessionKey);
const settled=sessions.filter(s=>!activeKeys.has(s.sessionKey));
const byKey=new Map(settled.map(s=>[s.sessionKey,s]));
const files=raw.fileRows.filter(r=>!activeKeys.has(r.sessionKey));
const db=raw.dbRows.filter(r=>!activeKeys.has(r.sessionKey));
const month=value=>typeof value==='string'?value.slice(0,7):'undated';
const sum=(rows,f)=>rows.reduce((n,r)=>n+f(r),0);
const tokens=s=>(s.tokens?.inputTokens??0)+(s.tokens?.outputTokens??0);
const compact=s=>({sessionKey:safeHash(s.sessionKey),repositoryId:safeRepositoryKey(s.repositoryId),createdAt:safeTimestamp(s.createdAt),firstEventAt:safeTimestamp(s.firstEventAt),lastEventAt:safeTimestamp(s.lastEventAt),input:s.tokens.inputTokens,cached:s.tokens.cachedInputTokens,output:s.tokens.outputTokens,total:tokens(s),usd:s.cost.totalUsd});
const fileKeys=new Set(files.map(r=>r.sessionKey));
const dbKeys=new Set(db.map(r=>r.sessionKey));
const months={};
const bucket=m=>months[m]??={dbThreads:0,dbCumulativeTokenSum:0,rollouts:0,rawLocalLastInput:0,rawLocalLastOutput:0,referenceSessionsByStart:0,referenceTokensByStart:0,referenceValueByStart:0,referenceValueByActivity:0,referenceTokensByActivity:0};
for(const d of db){const b=bucket(month(d.createdAt));b.dbThreads++;b.dbCumulativeTokenSum+=d.tokensUsed;}
for(const f of files){const b=bucket(month(f.firstAt));b.rollouts++;b.rawLocalLastInput+=f.rawLastUsage.input;b.rawLocalLastOutput+=f.rawLastUsage.output;}
for(const s of settled){const b=bucket(month(s.firstEventAt??s.createdAt));b.referenceSessionsByStart++;b.referenceTokensByStart+=tokens(s);b.referenceValueByStart+=s.cost.totalUsd;for(const[d,v]of Object.entries(s.spendByDay??{}))bucket(month(d)).referenceValueByActivity+=v;for(const[d,,,v]of s.velocity?.buckets??[])bucket(month(d)).referenceTokensByActivity+=v[1]+v[5];}
for(const[m,v]of Object.entries(raw.stateMonths)){const b=bucket(m);b.independentUniqueStateTokensByActivity=v.tokens.input+v.tokens.output;b.independentProviderTotalScalar=v.tokens.total;b.uniqueStates=v.states;b.sharedStates=v.sharedStates;}
const comparisons=files.map(f=>{const s=byKey.get(f.sessionKey);return{sessionKey:f.sessionKey,month:month(f.firstAt),afterCutoff:f.afterCutoff,dbTokensUsed:f.dbTokensUsed,lastCumulative:f.lastTotal?.total??null,localLastUsageTokens:f.rawLastUsage.input+f.rawLastUsage.output,reference:s?compact(s):null,referenceMinusLocalLast:s?tokens(s)-f.rawLastUsage.input-f.rawLastUsage.output:null,forked:f.forked,resets:f.resets,tokenRecords:f.tokenRecords};});
const dbMissingReference=db.filter(d=>!byKey.has(d.sessionKey));
const refMissingDb=settled.filter(s=>!dbKeys.has(s.sessionKey)).map(compact);
const history=raw.historySessions.filter(h=>!activeKeys.has(h.sessionKey)).map(h=>({...h,reference:byKey.has(h.sessionKey),rollout:fileKeys.has(h.sessionKey),db:dbKeys.has(h.sessionKey)}));
const output={generatedAt:ref.generatedAt,rawComputedAt:raw.computedAt,profiles:raw.profiles,aliases,coverage:{...raw.coverage,referenceSessions:sessions.length,settledReferenceSessions:settled.length,referenceExcluded:sessions.length-settled.length,settledDbThreads:db.length,matchedDb:db.length-dbMissingReference.length,dbMissingReference:dbMissingReference.length,refMissingDb:refMissingDb.length,settledRollouts:files.length,rolloutMissingReference:comparisons.filter(r=>!r.reference).length,referenceMissingRollout:settled.filter(s=>!fileKeys.has(s.sessionKey)).length},totals:{dbCumulativeTokenSum:sum(db,r=>r.tokensUsed),globalDeduplicatedLastTokens:raw.globalLastUsage.input+raw.globalLastUsage.output,providerScalarTotal:raw.globalLastUsage.total,referenceInput:sum(settled,s=>s.tokens.inputTokens),referenceCached:sum(settled,s=>s.tokens.cachedInputTokens),referenceOutput:sum(settled,s=>s.tokens.outputTokens),referenceTokens:sum(settled,tokens),referenceUsd:sum(settled,s=>s.cost.totalUsd),dbMissingReferenceCumulativeTokens:sum(dbMissingReference,r=>r.tokensUsed)},months,dbMissingReference,refMissingDb,history,comparisons};
const latestByKey=new Map();for(const f of files){const old=latestByKey.get(f.sessionKey);if(!old||f.lastAt>old.lastAt)latestByKey.set(f.sessionKey,f);}
output.dbCumulativeDivergences=db.filter(d=>latestByKey.get(d.sessionKey)?.lastTotal&&latestByKey.get(d.sessionKey).lastTotal.total!==d.tokensUsed).map(d=>({sessionKey:d.sessionKey,dbTokensUsed:d.tokensUsed,latestRolloutCumulative:latestByKey.get(d.sessionKey).lastTotal.total,dbMinusRollout:d.tokensUsed-latestByKey.get(d.sessionKey).lastTotal.total,dbUpdatedAt:d.updatedAt,rolloutLastAt:latestByKey.get(d.sessionKey).lastAt}));
output.totals.referenceMinusUniqueLastTokens=output.totals.referenceTokens-output.totals.globalDeduplicatedLastTokens;
if(existsSync('.lane/codex-accounting.json')){
 const accounting=JSON.parse(readFileSync('.lane/codex-accounting.json'));
 const evidence=JSON.parse(readFileSync('.lane/codex-fallback-evidence.json'));
 const duplicate=evidence.duplicateIntervals;
 const covered=evidence.intervals.filter(i=>{
  let current=i.total,seen=new Set();
  while(JSON.stringify(current)!==JSON.stringify(i.previous)){
   const state=evidence.usableStates.find(s=>JSON.stringify(s.total)===JSON.stringify(current)&&s.last[0]+s.last[2]>0);
   if(!state||seen.has(JSON.stringify(current)))return false;seen.add(JSON.stringify(current));current=state.total.map((n,j)=>n-state.last[j]);
  }return true;
 });
 const overcount=[...duplicate,...covered];
 output.reconciliation={missing:accounting.missing,duplicateFallbackTokens:sum(overcount,i=>i.delta[0]+i.delta[2]),duplicateFallbackUsd:sum(overcount,i=>i.usd),unexplainedTokens:0};
 for(const[m,a]of Object.entries(accounting.months)){
  const b=bucket(m),excess=overcount.filter(i=>month(i.timestamp)===m),missing=accounting.missingStates.filter(i=>month(i.timestamp)===m);
  b.independentUniqueStateTokensByActivity=a.input+a.output;
  b.cumulativeFallbackTokens=a.fallbackInput+a.fallbackOutput;
  b.duplicateFallbackTokens=sum(excess,i=>i.delta[0]+i.delta[2]);
  b.legitimateFallbackTokens=b.cumulativeFallbackTokens-b.duplicateFallbackTokens;
  b.correctedOracleTokens=b.independentUniqueStateTokensByActivity+b.legitimateFallbackTokens;
  b.missingTokens=sum(missing,i=>i.input+i.output);b.missingUsd=sum(missing,i=>i.usd);b.overcountUsd=sum(excess,i=>i.usd);
  b.correctedReferenceUsd=b.referenceValueByActivity+b.missingUsd-b.overcountUsd;
  b.unexplainedTokens=b.correctedOracleTokens-b.referenceTokensByActivity-b.missingTokens+b.duplicateFallbackTokens;
 }
 output.reconciliation.correctedReferenceTokens=output.totals.referenceTokens+accounting.missing.input+accounting.missing.output-output.reconciliation.duplicateFallbackTokens;
 output.reconciliation.correctedReferenceUsd=output.totals.referenceUsd+accounting.missing.usd-output.reconciliation.duplicateFallbackUsd;
 output.reconciliation.unexplainedTokens=sum(Object.values(months),b=>b.unexplainedTokens??0);
}
writeFileSync('.lane/codex-aggregates.json',JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({coverage:output.coverage,totals:output.totals,months,dbMissingReference,refMissingDb,history,comparisonDistribution:{zero:comparisons.filter(c=>c.referenceMinusLocalLast===0).length,referenceLess:comparisons.filter(c=>c.referenceMinusLocalLast<0).length,referenceMore:comparisons.filter(c=>c.referenceMinusLocalLast>0).length}},null,2));

});
