import './safe-failures.mjs';
// Independent event-window versus session-start-cohort oracle. No production imports.
import {readFileSync,writeFileSync} from 'node:fs';
const file=process.argv[2]??'../reference/snapshot-noindex-51ea561.json';
const data=JSON.parse(readFileSync(file,'utf8'));
const today=data.generatedAt.slice(0,10);const dayMillis=86400000;
const api=s=>s.costBasis==='api-list-price-equivalent';
const add=xs=>xs.reduce((a,b)=>a+b,0);
const result=[];
for (const days of [7,30,90,null]) {
 const start=days?new Date(Date.parse(today)-(days-1)*dayMillis).toISOString().slice(0,10):null;
 for(const provider of ['all',...new Set(data.sessions.map(s=>s.provider))]){
 const ss=data.sessions.filter(s=>provider==='all'||s.provider===provider);
 const cohort=ss.filter(s=>{const time=s.createdAt;return (!start||(s.transcript.startTimeKnown!==false&&s.evidence?.timing!=='file-mtime'&&time?.slice(0,10)>=start))&&(!time||time.slice(0,10)<=today)});
 const event=ss.flatMap(s=>Object.entries(s.spendByDay).map(([name,value])=>({name,value,api:api(s)}))).filter(d=>(!start||d.name>=start)&&d.name<=today);
 const cohortEvent=cohort.flatMap(s=>Object.entries(s.spendByDay).map(([name,value])=>({name,value}))).filter(d=>(!start||d.name>=start)&&d.name<=today);
 result.push({days,provider,start,end:today,cohortSessions:cohort.length,cohortApiUsd:add(cohort.filter(api).map(s=>s.cost.totalUsd)),cohortReportedUsd:add(cohort.filter(s=>s.costBasis==='provider-reported').map(s=>s.cost.totalUsd)),allEventUsd:add(event.map(d=>d.value)),cohortEventUsd:add(cohortEvent.map(d=>d.value)),missingDatedUsd:add(event.map(d=>d.value))-add(cohortEvent.map(d=>d.value)),cohortTokens:add(cohort.map(s=>s.tokens.inputTokens+s.tokens.outputTokens))});
 }
}
writeFileSync('.lane/window-oracle.json',JSON.stringify({asOf:data.generatedAt,windows:result},null,2));
console.log(JSON.stringify(result.filter(r=>r.provider==='all'),null,2));
