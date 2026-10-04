// Independent ledger reconciliation, separate from raw scanning; no src imports.
import {readFile,writeFile} from 'node:fs/promises';
import {priceUsage} from './pricing-oracle.mjs';
const data=JSON.parse(await readFile('.lane/codex-observations.json','utf8'));
for(const s of data.sessions){s.key=s.metas?.[0]?.id??s.key;s.metaAt=s.metas?.[0]?.at??s.metaAt;s.source=s.metas?.[0]?.source??s.source;}
const fileSessions=new Map(data.sessions.map(s=>[s.file,s]));for(const o of data.observations)o.key=fileSessions.get(o.file).key;
const ref=JSON.parse(await readFile(process.env.CODEX_ORACLE_REFERENCE??'../reference/snapshot-noindex-51ea561.json','utf8'));
let mapping={};try{mapping=JSON.parse(await readFile('.lane/codex-key-map.json','utf8'))}catch{}
const mapKey=k=>mapping[k]??k;
const z=()=>[0,0,0,0,0];const add=(a,b)=>a.map((v,i)=>v+b[i]);const positive=a=>a[0]+a[2]>0;
const total=v=>v[0]+v[2];const latest=new Map(data.sessions.map(s=>[s.file,s]));
const liveKeys=new Set(data.sessions.filter(s=>s.live).map(s=>s.key));
const sessionByKey=new Map(data.sessions.map(s=>[s.key,s]));
const ancestorKeys=s=>{const found=new Set();let k=s?.fork??s?.parent;while(k&&!found.has(k)){found.add(k);const a=sessionByKey.get(k);k=a?.fork??a?.parent;}return found;};
const generatedScore=o=>{const a=Date.parse(o.responseAt),t=Date.parse(o.at);return Number.isFinite(a)&&Number.isFinite(t)&&a<=t?t-a:Infinity;};
const perThread=new Map();const row=k=>{if(!perThread.has(k))perThread.set(k,{key:k,sessionKey:mapKey(k),live:liveKeys.has(k),response:z(),legacy:z(),hybrid:z(),usd:0,responseCount:0,legacyCount:0,ambiguousCount:0,inheritedResponses:0,models:{},months:{}});return perThread.get(k)};
for(const s of data.sessions)row(s.key);
const responseMap=new Map(),stateMap=new Map();let replay=0;let responseCopies=0;let invalidResponse=0;let responsesWithoutId=0;
for(const o of data.observations){
 const s=latest.get(o.file);const inherited=Boolean(s.fork&&Date.parse(o.at)<Date.parse(s.metaAt));
 if(o.kind==='response'){
  if(o.thread&&o.thread!==o.key){row(o.key).inheritedResponses++;continue}
  if(inherited){replay++;continue}
  if(!o.response){responsesWithoutId++;continue}
  const k=(o.thread??o.key)+':'+o.response;
  const prev=responseMap.get(k);if(prev){responseCopies++;if(JSON.stringify(prev.u)!==JSON.stringify(o.u))invalidResponse++;}
  if(!prev||total(o.u)>total(prev.u))responseMap.set(k,o);
 }else{
  if(inherited){replay++;continue}
  if(!stateMap.has(o.signature))stateMap.set(o.signature,[]);stateMap.get(o.signature).push(o);
 }
}
const requests=[];const responseMatch=new Map();
for(const o of responseMap.values()){
 const r=row(o.thread??o.key);r.response=add(r.response,o.u);r.responseCount++;
 const k=(o.thread??o.key)+':'+JSON.stringify(o.u);if(!responseMatch.has(k))responseMatch.set(k,[]);responseMatch.get(k).push(o);
 requests.push({...o,basis:'response',key:o.thread??o.key});
}
let ambiguousStates=0,noLocalResponseStates=0,baselineStates=0,deltaStates=0,legacyPaired=0,legacyUnpaired=0;
const disputes=[];
for(const [signature,all]of stateMap){
 // Repeated observations in one file are a single claim; a local response since the prior counter is direct evidence.
 const unique=new Map();for(const o of all){const old=unique.get(o.key);if(!old||generatedScore(o)<generatedScore(old)||(generatedScore(o)===generatedScore(old)&&o.at<old.at))unique.set(o.key,o)}
 const originalCandidates=[...unique.values()];
 const candidates=originalCandidates.filter(o=>{const s=latest.get(o.file),parents=ancestorKeys(s);return !all.some(p=>parents.has(p.key)&&Date.parse(p.at)<Date.parse(s.metaAt));});
 if(!candidates.length)continue;const direct=candidates.filter(o=>o.localResponse);
 const choices=candidates;
 choices.sort((a,b)=>generatedScore(a)-generatedScore(b)||Date.parse(a.at)-Date.parse(b.at)||a.file-b.file);
 const receiptBacked=all.find(o=>(responseMatch.get(o.key+':'+JSON.stringify(o.u))??[]).some(p=>p.turn===o.turn||!p.turn||!o.turn));
 const o=receiptBacked??choices[0];let ambiguous=!receiptBacked&&choices.length>1;
 if(ambiguous){ambiguousStates++;if(disputes.length<30)disputes.push({signature,claimants:choices.length,keys:choices.map(o=>o.key),at:o.at,u:o.u})}
 if(!direct.length)noLocalResponseStates++;
 let u=o.u;
 if(!positive(u)){if(!o.delta||o.delta.some(v=>v<0)){baselineStates++;continue}u=o.delta;if(!positive(u))continue;deltaStates++;}
 const r=row(o.key);r.legacy=add(r.legacy,u);r.legacyCount++;if(ambiguous)r.ambiguousCount++;
 const match=responseMatch.get(o.key+':'+JSON.stringify(u))??[];
 // Match exact usage in the same turn: transport buffering can delay a counter by minutes.
 const paired=match.some(p=>p.turn===o.turn||!p.turn||!o.turn);
 if(paired){legacyPaired++;continue}
 legacyUnpaired++;requests.push({...o,u,basis:'legacy',ambiguous,requestSizeKnown:positive(o.u)});
}
for(const q of requests){
 const r=row(q.key);r.hybrid=add(r.hybrid,q.u);
 const model=q.model??(latest.get(q.file)?.modelList.length===1?latest.get(q.file).modelList[0]:'unknown');q.model=model;
 r.usd+=priceUsage(model,{input_tokens:q.u[0],cached_input_tokens:q.u[1],output_tokens:q.u[2],reasoning_output_tokens:q.u[3]},{timestamp:q.at,requestInputTokens:q.basis==='response'||q.requestSizeKnown?q.u[0]:null}).totalUsd;
 r.models[model]=add(r.models[model]??z(),q.u);
 const month=typeof q.at==='string'?q.at.slice(0,7):'unknown';r.months[month]=add(r.months[month]??z(),q.u);
}
const codex=ref.sessions.filter(s=>s.provider==='codex');const byKey=new Map(codex.map(s=>[s.sessionKey,s]));const matched=[],missing=[];
let sums={oracle:z(),reference:z(),response:z(),legacy:z()};let months={};let models={};
for(const r of perThread.values()){
 if(r.live)continue;const s=byKey.get(r.sessionKey);if(!s){missing.push({key:r.key,tokens:total(r.hybrid),metaAt:data.sessions.find(d=>d.key===r.key)?.metaAt});continue}
 const reference=[s.tokens.inputTokens,s.tokens.cachedInputTokens,s.tokens.outputTokens,s.tokens.reasoningOutputTokens,s.tokens.cacheWriteInputTokens];
 const delta=r.hybrid.map((v,i)=>v-reference[i]);matched.push({...r,reference,delta,referenceUsd:s.cost.totalUsd,repositoryKey:s.repositoryId,referenceModels:s.models.map(m=>({model:m.model,u:[m.inputTokens,m.cachedInputTokens,m.outputTokens,m.reasoningOutputTokens,m.cacheWriteInputTokens],usd:m.totalUsd})),referenceMonths:Object.entries(s.spendByDay).map(([day,usd])=>({month:day.slice(0,7),usd}))});
 for(const k of ['oracle','reference','response','legacy'])sums[k]=add(sums[k],k==='oracle'?r.hybrid:k==='reference'?reference:r[k]);
 for(const [model,u]of Object.entries(r.models)){models[model]??={oracle:z(),reference:z()};models[model].oracle=add(models[model].oracle,u)}
 for(const m of s.models){models[m.model]??={oracle:z(),reference:z()};models[m.model].reference=add(models[m.model].reference,[m.inputTokens,m.cachedInputTokens,m.outputTokens,m.reasoningOutputTokens,m.cacheWriteInputTokens])}
 for(const [month,u]of Object.entries(r.months)){months[month]??={oracle:z(),referenceUsd:0};months[month].oracle=add(months[month].oracle,u)}
}
const summary={generatedAt:ref.generatedAt,stats:data.stats,files:data.sessions.length,uniqueThreads:perThread.size,liveThreads:liveKeys.size,referenceSessions:codex.length,matched:matched.length,missing:missing.length,differing:matched.filter(r=>r.delta.some(v=>v!==0)).length,oracleUsd:matched.reduce((a,r)=>a+r.usd,0),sums,uniqueResponses:responseMap.size,responseCopies,invalidResponse,responsesWithoutId,replay,uniqueLegacyStates:stateMap.size,ambiguousStates,noLocalResponseStates,baselineStates,deltaStates,legacyPaired,legacyUnpaired,models,months};
await writeFile('.lane/codex-comparison.json',JSON.stringify({summary,matched,missing,disputes,requests:requests.map(({key,u,model,at,basis,ambiguous,signature,response,turn})=>({key,u,model,at,basis,ambiguous,signature,response,turn}))}));
console.log(JSON.stringify(summary,null,2));
