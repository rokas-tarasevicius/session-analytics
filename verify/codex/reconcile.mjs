/** Final evidence-backed reconciliation. All unresolved legacy ownership remains explicitly heuristic. */
import {readFile,writeFile} from 'node:fs/promises';
import {priceUsage} from './pricing-oracle.mjs';
const read=async p=>JSON.parse(await readFile(p,'utf8'));
const [control,raw,forks,receipts,ref,map,heuristic,collisions]=await Promise.all([
 read('.lane/codex-source-control.json'),read('.lane/codex-observations.json'),read('.lane/codex-fork-replay-audit.json'),read('.lane/codex-receipts-audit.json'),read('../reference/snapshot-noindex-51ea561.json'),read('.lane/codex-key-map.json'),read('.lane/codex-comparison.json'),read('.lane/codex-collisions.json')]);
const zero=()=>[0,0,0,0,0],add=(a,b)=>a.map((v,i)=>v+b[i]),pos=u=>u[0]+u[2]>0;
const fileByKey=new Map(raw.sessions.map(s=>[s.key,s]));
const liveKeys=new Set(raw.sessions.filter(s=>s.live).map(s=>s.key));
const stable=new Set(raw.sessions.filter(s=>!liveKeys.has(s.key)).map(s=>s.key));
const references=new Map(ref.sessions.filter(s=>s.provider==='codex').map(s=>[s.sessionKey,s]));
const key=k=>map[k]??k;
const replay=new Map(forks.rows.filter(r=>pos(r.usage)).map(r=>[r.signature,r]));
const originals=new Map(),byOwnerState=new Map();for(const o of raw.observations)if(o.kind==='legacy'){originals.set(o.key+':'+o.signature+':'+o.at,o);const k=o.key+':'+o.signature;if(!byOwnerState.has(k)||Date.parse(o.at)<Date.parse(byOwnerState.get(k).at))byOwnerState.set(k,o);}
let corrected=[],changes=[];const cumulative=new Map();
for(const q of control.requests){
 if(!stable.has(q.key)||!references.has(key(q.key)))continue;
 const o=originals.get(q.key+':'+q.signature+':'+q.at);
 if(o&&!pos(o.u)){
  if(!cumulative.has(q.signature))cumulative.set(q.signature,[]);cumulative.get(q.signature).push(q);continue;
 }
 const r=replay.get(q.signature);
 if(r&&r.fromKey===q.key){
  const ancestor=byOwnerState.get(r.toKey+':'+q.signature);
  const after={...q,key:r.toKey,model:r.toModel,month:r.toMonth,at:ancestor?.at??q.at,usd:r.toUsd};corrected.push(after);changes.push({bug:'CODEX-02',before:q,after});
 }else corrected.push(q);
}
for(const group of cumulative.values()){
 // This real-data pair is an exact repeated delta in an explicitly linked fork.
 group.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
 const first=group[0];corrected.push(first);
 for(const q of group.slice(1)){
  const f=fileByKey.get(q.key);const isReplay=f?.fork===first.key&&Date.parse(first.at)<Date.parse(f.metaAt)&&JSON.stringify(q.u)===JSON.stringify(first.u);
  if(isReplay)changes.push({bug:'CODEX-05',before:q,after:null});else corrected.push(q);
 }
}
for(const r of receipts.missing){const after={key:r.threadKey,u:r.usage,model:r.model,at:r.at,month:r.at.slice(0,7),usd:r.usd,basis:'response'};corrected.push(after);changes.push({bug:'CODEX-01',before:null,after});}
for(const r of collisions.uncovered){const after={key:r.threadKey,u:r.usage,model:r.model,at:r.at,month:r.at.slice(0,7),usd:r.usd,basis:'response'};corrected.push(after);changes.push({bug:'CODEX-06',before:null,after});}
const aggregate=list=>{const sessions={},models={},months={},repositories={};for(const q of list){
 const s=references.get(key(q.key));if(!s)continue;
 for(const [dict,id]of [[sessions,s.sessionKey],[models,q.model??'<unknown>'],[months,q.month],[repositories,s.repositoryId]]){dict[id]??={u:zero(),usd:0,requests:0};dict[id].u=add(dict[id].u,q.u);dict[id].usd+=q.usd;dict[id].requests++;}
 }return {sessions,models,months,repositories}};
const result=aggregate(corrected),comparison={sessions:[],models:[],months:[],repositories:[]};
const token=s=>[s.inputTokens,s.cachedInputTokens,s.outputTokens,s.reasoningOutputTokens,s.cacheWriteInputTokens];
let baseline={sessions:{},models:{},months:{},repositories:{}};
for(const s of references.values()){
 baseline.sessions[s.sessionKey]={u:token(s.tokens),usd:s.cost.totalUsd};
 baseline.repositories[s.repositoryId]??={u:zero(),usd:0};baseline.repositories[s.repositoryId].u=add(baseline.repositories[s.repositoryId].u,token(s.tokens));baseline.repositories[s.repositoryId].usd+=s.cost.totalUsd;
 for(const m of s.models){baseline.models[m.model]??={u:zero(),usd:0};baseline.models[m.model].u=add(baseline.models[m.model].u,token(m));baseline.models[m.model].usd+=m.totalUsd;}
 for(const [day,usd]of Object.entries(s.spendByDay)){const month=day.slice(0,7);baseline.months[month]??={usd:0};baseline.months[month].usd+=usd;}
}
for(const area of Object.keys(comparison))for(const id of new Set([...Object.keys(baseline[area]),...Object.keys(result[area])])){
 const a=result[area][id]??{u:zero(),usd:0},b=baseline[area][id]??{u:zero(),usd:0};comparison[area].push({key:id,oracle:a,reference:b,deltaUsd:a.usd-b.usd,...(b.u?{delta:a.u.map((v,i)=>v-b.u[i])}:{})});
}
const totals=Object.values(result.sessions).reduce((a,b)=>({u:add(a.u,b.u),usd:a.usd+b.usd}),{u:zero(),usd:0});
const referenceTotals=Object.values(baseline.sessions).reduce((a,b)=>({u:add(a.u,b.u),usd:a.usd+b.usd}),{u:zero(),usd:0});
const perBug={};for(const c of changes){perBug[c.bug]??={positiveTokens:0,negativeTokens:0,deltaUsd:0,changes:0,sessionKeys:new Set(),months:new Set()};const r=perBug[c.bug];r.changes++;for(const [q,sign]of [[c.before,-1],[c.after,1]])if(q){r.deltaUsd+=sign*q.usd;r[sign>0?'positiveTokens':'negativeTokens']+=q.u[0]+q.u[2];r.sessionKeys.add(key(q.key));r.months.add(q.month)}}
for(const r of Object.values(perBug)){r.sessions=r.sessionKeys.size;r.months=[...r.months].sort();r.sessionKeys=[...r.sessionKeys]}
const heuristicDiscrepancies=heuristic.matched.filter(r=>r.delta.some(v=>v!==0));
const explainedBy=new Map(changes.flatMap(c=>[c.before,c.after].filter(Boolean).map(q=>[key(q.key),true])));
const remaining=heuristic.matched.map(r=>({...r,remaining:r.hybrid.map((v,i)=>v-(result.sessions[r.sessionKey]?.u[i]??0))})).filter(r=>r.remaining.some(v=>v!==0));
const summary={referenceGeneratedAt:ref.generatedAt,referenceSessions:references.size,sessions:references.size,sessionsWithChargedUsage:Object.keys(result.sessions).length,sessionsWithoutChargedUsage:[...references.values()].filter(s=>!result.sessions[s.sessionKey]).length,totals,referenceTotals,delta:totals.u.map((v,i)=>v-referenceTotals.u[i]),deltaUsd:totals.usd-referenceTotals.usd,changedSessions:comparison.sessions.filter(r=>r.delta.some(v=>v!==0)||Math.abs(r.deltaUsd)>1e-7).length,changedRepositories:comparison.repositories.filter(r=>r.delta.some(v=>v!==0)||Math.abs(r.deltaUsd)>1e-7).length,perBug,sourceControlResidual:{bug:'CODEX-07',deltaUsd:control.summary.deltaUsd,inputTokens:control.summary.inputDelta,outputTokens:control.summary.outputDelta,sessions:control.summary.changed},heuristicDiscrepancies:heuristicDiscrepancies.length,remainingHeuristicDisagreements:remaining.length};
await writeFile('.lane/codex-reconciled.json',JSON.stringify({summary,comparison,changes,heuristicOnlyUnresolved:remaining.map(r=>({sessionKey:r.sessionKey,delta:r.remaining,ambiguousCount:r.ambiguousCount}))},null,2));
console.log(JSON.stringify({...summary,perBug:Object.fromEntries(Object.entries(perBug).map(([k,{sessionKeys,...r}])=>[k,r])),months:comparison.months.map(r=>({month:r.key,referenceUsd:r.reference.usd,correctedUsd:r.oracle.usd,deltaUsd:r.deltaUsd})),models:comparison.models.map(r=>({model:r.key,delta:r.delta,deltaUsd:r.deltaUsd}))},null,2));
