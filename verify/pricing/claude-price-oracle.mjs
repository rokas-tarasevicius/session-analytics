// Standalone arithmetic written from raw token semantics + independently sourced official rates.
import fs from 'node:fs';
import crypto from 'node:crypto';
const snapshot=JSON.parse(fs.readFileSync(process.argv[2]||'../reference/snapshot-noindex-51ea561.json','utf8'));
const requests=JSON.parse(fs.readFileSync('.lane/pricing-claude-requests.json','utf8'));
const {rates}=JSON.parse(fs.readFileSync('verify/pricing/official-rates.json','utf8'));
const refs=new Map(snapshot.sessions.map(s=>[s.sessionKey,s]));
const sessions=new Map(),byModel={},byMonth={},byRepository={};
const zero=()=>({inputUsd:0,cachedInputUsd:0,cacheWriteUsd:0,outputUsd:0,totalUsd:0});
const add=(a,b)=>{for(const k of Object.keys(zero()))a[k]+=b[k];return a;};
let priced=0,unpriced=0;
for(const r of requests){
  const rate=rates[r.model];if(!rate){unpriced++;continue;}priced++;
  const unsplit=Math.max(0,r.cacheWriteInputTokens-r.cacheWrite5mInputTokens-r.cacheWrite1hInputTokens);
  const cost={inputUsd:r.uncachedInputTokens*rate.input/1e6,cachedInputUsd:r.cachedInputTokens*rate.cacheRead/1e6,
    cacheWriteUsd:((r.cacheWrite5mInputTokens+unsplit)*rate.cacheWrite5m+r.cacheWrite1hInputTokens*rate.cacheWrite1h)/1e6,
    outputUsd:r.outputTokens*rate.output/1e6,totalUsd:0};
  cost.totalUsd=cost.inputUsd+cost.cachedInputUsd+cost.cacheWriteUsd+cost.outputUsd;
  if(!sessions.has(r.sessionKey))sessions.set(r.sessionKey,zero());add(sessions.get(r.sessionKey),cost);
  add(byModel[r.model]??=zero(),cost);add(byMonth[r.timestamp?.slice(0,7)||'undated']??=zero(),cost);
  const repositoryKey=crypto.createHash('sha256').update(refs.get(r.sessionKey).repositoryId).digest('hex').slice(0,12);
  add(byRepository[repositoryKey]??=zero(),cost);
}
const differences=[];let totalExpected=0,totalReference=0;
for(const [key,cost] of sessions){
  const reference=refs.get(key).cost;totalExpected+=cost.totalUsd;totalReference+=reference.totalUsd;
  const delta={};for(const k of Object.keys(zero()))if(Math.abs(cost[k]-reference[k])>1e-7)delta[k]=cost[k]-reference[k];
  if(Object.keys(delta).length)differences.push({sessionKey:key,delta,expected:cost,reference});
}
const referenceByMonth={};
for(const key of sessions.keys())for(const [day,value] of Object.entries(refs.get(key).spendByDay)) {
  const month=day.slice(0,7);referenceByMonth[month]=(referenceByMonth[month]||0)+value;
}
const monthDifferences=Object.keys({...byMonth,...referenceByMonth}).map(month=>({month,
  expected:byMonth[month]?.totalUsd||0,reference:referenceByMonth[month]||0,
  delta:(byMonth[month]?.totalUsd||0)-(referenceByMonth[month]||0)}));
const out={officialRatesVerifiedAt:'2026-10-03',matchedSessions:sessions.size,pricedRequests:priced,unpricedRequests:unpriced,
  totalExpected,totalReference,delta:totalExpected-totalReference,differences,byModel,byMonth,byRepository,monthDifferences,
  assumptions:['Standard global token prices; actual recorded nonstandard speed/geo require modifiers.','Unsplit writes assumed 5m; hidden fallback attempts not represented in returned-message top-level counters.']};
fs.writeFileSync('.lane/pricing-claude-cost.json',JSON.stringify(out,null,2)+'\n');
console.log(JSON.stringify({...out,byRepository:undefined,differences:out.differences.slice(0,5)},null,2));
