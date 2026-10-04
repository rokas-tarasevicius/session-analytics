// Prove overlap from arithmetic, without guessing where SDK process resets occur.
process.on('uncaughtException',()=>{console.error('Oracle failed; private details suppressed.');process.exit(1);});
process.on('unhandledRejection',()=>{console.error('Oracle failed; private details suppressed.');process.exit(1);});
import {readFileSync,writeFileSync} from 'node:fs';
const sem=JSON.parse(readFileSync('.lane/conductor-semantics.json','utf8'));
const acc=JSON.parse(readFileSync('.lane/conductor-accounting.json','utf8'));
const refs=new Map(acc.sessions.filter(s=>s.oldVersions).map(s=>[s.sessionKey,s]));
const fields=[['inputTokens','input_tokens'],['outputTokens','output_tokens'],['cacheReadInputTokens','cache_read_input_tokens'],['cacheCreationInputTokens','cache_creation_input_tokens']];
const modelCost=r=>Object.values(r.modelUsage).reduce((a,u)=>a+(u.costUSD||0),0);
const eq=(a,b)=>Math.abs(a-b)<1e-7;
const certificates=[];
for(const s of sem.sessions){const rf=refs.get(s.sessionKey);if(!rf)continue;let p;
 const elected=new Map();for(const r of s.results){const prior=elected.get(r.initCountBefore);if(!prior||r.totalCostUsd>=prior.totalCostUsd)elected.set(r.initCountBefore,r);}const selected=new Set([...elected.values()].map(r=>r.sequence));
 if(!eq([...elected.values()].reduce((a,r)=>a+r.totalCostUsd,0),rf.referenceUsd))continue;
 for(const r of s.results){
  if(p&&p.sdkSessionKey&&selected.has(p.sequence)&&selected.has(r.sequence)&&r.sdkSessionKey===p.sdkSessionKey&&r.initCountBefore>p.initCountBefore&&eq(modelCost(r),r.totalCostUsd)&&eq(modelCost(p),p.totalCostUsd)){
   let match=[...Object.values(p.modelUsage),...Object.values(r.modelUsage)].every(u=>fields.every(([mf])=>Number.isFinite(u[mf]))&&Number.isFinite(u.costUSD));
   for(const [model,u] of Object.entries(p.modelUsage)){const v=r.modelUsage[model];if(!v||fields.some(([mf])=>v[mf]<u[mf])||v.costUSD<u.costUSD-1e-7)match=false;}
   const before={},after={},local={};let prevTokens=0;
   for(const [mf,uf] of fields){before[mf]=Object.values(p.modelUsage).reduce((a,u)=>a+(u[mf]||0),0);after[mf]=Object.values(r.modelUsage).reduce((a,u)=>a+(u[mf]||0),0);local[mf]=r.usage[uf];if(after[mf]-before[mf]!==local[mf])match=false;prevTokens+=before[mf];}
   if(match&&p.totalCostUsd>0)certificates.push({sessionKey:s.sessionKey,referenceSessionKey:rf.referenceSessionKey,month:rf.month,previousSequence:p.sequence,currentSequence:r.sequence,duplicatedPreviousCostUsd:p.totalCostUsd,duplicatedPreviousTokens:prevTokens,before,after,turnLocal:local});
  }
  p=r;
 }
}
const byMonth={};for(const c of certificates){const b=byMonth[c.month]??={pairs:0,costUsd:0,tokens:0,sessions:new Set()};b.pairs++;b.costUsd+=c.duplicatedPreviousCostUsd;b.tokens+=c.duplicatedPreviousTokens;b.sessions.add(c.sessionKey);}for(const b of Object.values(byMonth))b.sessions=b.sessions.size;
const summary={pairs:certificates.length,sessions:new Set(certificates.map(x=>x.sessionKey)).size,duplicatedCostUsd:certificates.reduce((a,x)=>a+x.duplicatedPreviousCostUsd,0),duplicatedTokens:certificates.reduce((a,x)=>a+x.duplicatedPreviousTokens,0)};
writeFileSync('.lane/conductor-overlap-certificates.json',JSON.stringify({summary,byMonth,certificates},null,2)+'\n');console.log(JSON.stringify({summary,byMonth},null,2));
