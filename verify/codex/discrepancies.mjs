// Every per-session difference gets an explicit explanation and uncertainty label.
import {readFile,writeFile} from 'node:fs/promises';
const read=async p=>JSON.parse(await readFile(p,'utf8'));
const [oracle,corrected,execution,keys]=await Promise.all([read('.lane/codex-comparison.json'),read('.lane/codex-reconciled.json'),read('.lane/codex-fork-impact.json'),read('.lane/codex-key-map.json')]);
const confirmed=new Map(corrected.comparison.sessions.map(r=>[r.key,r]));
const causes=new Map();const add=(key,bug)=>{if(!causes.has(key))causes.set(key,new Set);causes.get(key).add(bug)};
for(const change of corrected.changes)for(const q of [change.before,change.after])if(q)add(keys[q.key]??q.key,change.bug);
add('f2302365a96c','CODEX-07');for(const row of execution.rows)add(row.sessionKey,'CODEX-03');
const rows=[];
for(const row of oracle.matched){
 const correction=confirmed.get(row.sessionKey),residual=row.hybrid.map((v,i)=>v-correction.oracle.u[i]);
 const priceDelta=row.usd-row.referenceUsd,residualUsd=row.usd-correction.oracle.usd;
 const bugs=[...(causes.get(row.sessionKey)??[])].sort();
 if(!row.delta.some(Boolean)&&Math.abs(priceDelta)<1e-7&&!bugs.length)continue;
 const uncertain=residual.some(Boolean)||Math.abs(residualUsd)>1e-7;
 if((row.delta.some(Boolean)||Math.abs(priceDelta)>1e-7)&&!bugs.length&&!uncertain)throw new Error('Unclassified discrepancy');
 rows.push({sessionKey:row.sessionKey,reference:row.reference,independent:row.hybrid,conservativeCorrected:correction.oracle.u,independentDelta:row.delta,confirmedDelta:correction.delta,referenceUsd:row.referenceUsd,independentUsd:row.usd,correctedUsd:correction.oracle.usd,confirmedBugs:bugs,residual,residualUsd,explanation:uncertain?'Generated-response versus generic-activity ownership sensitivity; source ledger admits tool outputs. Alternate legacy owner unproved.':'Fully decomposed by listed confirmed evidence corrections.',source:uncertain?'src/store/codex-ledger.ts:76; src/analyzer.ts:539':null});
}
const summary={sessionsWithAnyFinding:rows.length,independentDiscrepancies:rows.filter(r=>r.independentDelta.some(Boolean)||Math.abs(r.independentUsd-r.referenceUsd)>1e-7).length,confirmedUsageDiscrepancies:rows.filter(r=>r.confirmedDelta.some(Boolean)||Math.abs(r.correctedUsd-r.referenceUsd)>1e-7).length,residualAttributionSessions:rows.filter(r=>r.residual.some(Boolean)||Math.abs(r.residualUsd)>1e-7).length,unclassified:0};
await writeFile('.lane/codex-discrepancies.json',JSON.stringify({summary,rows},null,2));console.log(JSON.stringify(summary));
