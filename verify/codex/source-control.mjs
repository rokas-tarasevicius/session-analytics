// Post-oracle control: reproduce the documented source heuristic on sanitized facts.
// This is not the independent oracle; its purpose is discrepancy decomposition.
import{readFile,writeFile}from'node:fs/promises';
import{priceUsage}from'./pricing-oracle.mjs';
const d=JSON.parse(await readFile('.lane/codex-observations.json'));
const ref=JSON.parse(await readFile('../reference/snapshot-noindex-51ea561.json'));
const keys=JSON.parse(await readFile('.lane/codex-key-map.json'));
const z=()=>[0,0,0,0,0],add=(a,b)=>a.map((v,i)=>v+b[i]),pos=u=>u[0]+u[2]>0;
const fileSessions=new Map(d.sessions.map(s=>[s.file,s]));
const tokenEvents=d.observations.filter(o=>o.kind==='legacy');const ledger=new Map();
const score=o=>{const a=Date.parse(o.activityAt),t=Date.parse(o.at);return Number.isFinite(a)&&Number.isFinite(t)&&a<=t?t-a:Infinity};
for(const o of tokenEvents){if(!o.at)continue;const prev=ledger.get(o.signature);if(!prev||score(o)<score(prev)||(score(o)===score(prev)&&o.at<prev.at))ledger.set(o.signature,o)}
const liveByKey=new Map();for(const s of d.sessions)liveByKey.set(s.key,(liveByKey.get(s.key)??false)||s.live);
const threads=new Map;const ensure=k=>{if(!threads.has(k))threads.set(k,{key:k,sessionKey:keys[k]??k,u:z(),usd:0,requests:0,models:{},months:{},live:liveByKey.get(k)??false});return threads.get(k)};
for(const s of d.sessions)ensure(s.key);
const claimed=new Set;let requests=[];
for(const o of tokenEvents){
 const owner=ledger.get(o.signature);let u;
 if(pos(o.u)){if((owner&&(owner.file!==o.file||owner.at!==o.at))||claimed.has(o.signature))continue;claimed.add(o.signature);u=o.u;}
 else{u=o.delta?.every(v=>v>=0)?o.delta:z();if(!pos(u))continue;}
 const r=ensure(o.key);r.u=add(r.u,u);r.requests++;
 const model=o.model??(fileSessions.get(o.file).modelList.length===1?fileSessions.get(o.file).modelList[0]:'<unknown>');
 const price=priceUsage(model,{input_tokens:u[0],cached_input_tokens:u[1],output_tokens:u[2],reasoning_output_tokens:u[3]},{timestamp:o.at,requestInputTokens:pos(o.u)?u[0]:null});r.usd+=price.totalUsd;
 const month=o.at?.slice(0,7)??'unknown';r.models[model]=add(r.models[model]??z(),u);r.months[month]??={u:z(),usd:0};r.months[month].u=add(r.months[month].u,u);r.months[month].usd+=price.totalUsd;
 requests.push({key:o.key,model,month,u,usd:price.totalUsd,at:o.at,signature:o.signature,activityType:o.activityType,score:Number.isFinite(score(o))?score(o):null});
}
const snap=new Map(ref.sessions.filter(s=>s.provider==='codex').map(s=>[s.sessionKey,s]));let matched=[],missing=[];
for(const r of threads.values()){if(r.live)continue;const s=snap.get(r.sessionKey);if(!s){missing.push(r);continue;}const expected=[s.tokens.inputTokens,s.tokens.cachedInputTokens,s.tokens.outputTokens,s.tokens.reasoningOutputTokens,s.tokens.cacheWriteInputTokens];matched.push({...r,expected,delta:r.u.map((v,i)=>v-expected[i]),deltaUsd:r.usd-s.cost.totalUsd,referenceUsd:s.cost.totalUsd,repositoryKey:s.repositoryId});}
const changed=matched.filter(r=>r.delta.some(v=>v!==0)||Math.abs(r.deltaUsd)>1e-7);
const summary={matched:matched.length,changed:changed.length,missing:missing.length,inputDelta:matched.reduce((s,r)=>s+r.delta[0],0),outputDelta:matched.reduce((s,r)=>s+r.delta[2],0),deltaUsd:matched.reduce((s,r)=>s+r.deltaUsd,0),oracleUsd:matched.reduce((s,r)=>s+r.usd,0),referenceUsd:matched.reduce((s,r)=>s+r.referenceUsd,0)};
await writeFile('.lane/codex-source-control.json',JSON.stringify({summary,matched,missing,requests}));console.log(JSON.stringify({summary,changed:changed.slice(0,15).map(({key,u,expected,delta,deltaUsd})=>({key,u,expected,delta,deltaUsd}))},null,2));
