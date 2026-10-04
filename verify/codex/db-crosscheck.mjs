#!/usr/bin/env node
// Cross-check the independent raw projection with the immutable SQLite oracle.
import { readFileSync, writeFileSync } from 'node:fs';
const raw=JSON.parse(readFileSync('.lane/codex-observations.json','utf8'));
const db=JSON.parse(readFileSync('.lane/codex-db-oracle.json','utf8'));
const sample=JSON.parse(readFileSync('.lane/codex-db-raw-sample.json','utf8'));
const scalarEvidence=new Map(sample.threads.map(row=>[row.threadKey,row.lastTotal?.total_tokens]));
const tokens=u=>u ? u[0]+u[2] : null;
const files=new Map(raw.sessions.map(s=>[s.file,{...s,firstKey:s.metas[0]?.id||s.key,events:[]}])) ;
for(const o of raw.observations)files.get(o.file)?.events.push(o);
const byThread=new Map();
for(const f of files.values()){const list=byThread.get(f.firstKey)||[];list.push(f);byThread.set(f.firstKey,list);}
const rows=[];
const summary={dbThreads:db.threads.length,stable:0,rawMissing:0,rawLive:0,withLegacy:0,equalsFinalLegacy:0,withResponses:0,equalsFinalResponseThreadTotal:0,equalsEitherFinal:0,equalsNeitherFinal:0,noUsageZeroDatabase:0,scalarOnlyFinal:0,staleDatabaseCounter:0,databaseAheadOfAvailableRollout:0,dbBelowSnapshot:0};
for(const d of db.threads){const fs=byThread.get(d.threadKey)||[];if(d.afterCutoff)continue;summary.stable++;
  if(!fs.length){summary.rawMissing++;rows.push({threadKey:d.threadKey,sessionKey:d.sessionKey,tokensUsed:d.tokensUsed,missingRaw:true});continue;}
  if(fs.some(f=>f.live)){summary.rawLive++;continue;}
  const fileRows=fs.map(f=>{const legacy=f.events.filter(o=>o.kind==='legacy');const responses=f.events.filter(o=>o.kind==='response');const ownResponses=responses.filter(o=>o.thread===d.threadKey);return{
    fileOrdinal:f.file,metadataCount:f.metaCount,metadataKeys:f.metas.map(m=>m.id),fork:f.fork,parent:f.parent,source:f.source,
    firstTotal:tokens(legacy[0]?.total),finalTotal:tokens(legacy.at(-1)?.total),maxTotal:Math.max(0,...legacy.map(o=>tokens(o.total))),
    distinctTotalStates:new Set(legacy.map(o=>JSON.stringify(o.total))).size,
    totalBackwards:legacy.reduce((sum,o,i)=>sum+Number(i>0&&tokens(o.total)<tokens(legacy[i-1].total)),0),
    finalResponseThreadTotal:tokens(ownResponses.at(-1)?.threadTotal),responseCount:responses.length,ownResponseCount:ownResponses.length,
    lastResponseCountOwn:responses.at(-1)?.thread===d.threadKey,
    responseSum:ownResponses.reduce((sum,o)=>sum+tokens(o.u),0),
    legacyCount:legacy.length,
    earlierDatabaseCounterMatches:legacy.filter(o=>tokens(o.total)===d.tokensUsed).length,
    latestEarlierDatabaseCounterAt:legacy.filter(o=>tokens(o.total)===d.tokensUsed).at(-1)?.at||null,
    finalCounterAt:legacy.at(-1)?.at||null,
  }});
  const hasLegacy=fileRows.some(f=>f.legacyCount>0);const hasResponse=fileRows.some(f=>f.ownResponseCount>0);
  const matchesLegacy=fileRows.some(f=>f.finalTotal===d.tokensUsed);const matchesResponse=fileRows.some(f=>f.finalResponseThreadTotal===d.tokensUsed);
  if(hasLegacy)summary.withLegacy++;if(hasResponse)summary.withResponses++;if(matchesLegacy)summary.equalsFinalLegacy++;if(matchesResponse)summary.equalsFinalResponseThreadTotal++;
  if(matchesLegacy||matchesResponse)summary.equalsEitherFinal++;else summary.equalsNeitherFinal++;
  const noUsageZeroDatabase=!hasLegacy&&!hasResponse&&d.tokensUsed===0;
  const scalarOnlyFinal=!matchesLegacy&&scalarEvidence.get(d.threadKey)===d.tokensUsed&&fileRows.some(f=>f.finalTotal===0);
  if(noUsageZeroDatabase)summary.noUsageZeroDatabase++;
  if(scalarOnlyFinal)summary.scalarOnlyFinal++;
  const staleDatabaseCounter=!matchesLegacy&&!matchesResponse&&!noUsageZeroDatabase&&!scalarOnlyFinal&&fileRows.some(f=>f.earlierDatabaseCounterMatches>0);
  if(staleDatabaseCounter)summary.staleDatabaseCounter++;
  const databaseAheadOfAvailableRollout=!matchesLegacy&&!matchesResponse&&!noUsageZeroDatabase&&!scalarOnlyFinal&&!staleDatabaseCounter;
  if(databaseAheadOfAvailableRollout)summary.databaseAheadOfAvailableRollout++;
  if(d.differenceFromSnapshot<0)summary.dbBelowSnapshot++;
  rows.push({threadKey:d.threadKey,sessionKey:d.sessionKey,tokensUsed:d.tokensUsed,snapshotTokens:d.snapshotTokens,snapshotUsd:d.snapshotUsd,differenceFromSnapshot:d.differenceFromSnapshot,matchesLegacy,matchesResponse,noUsageZeroDatabase,scalarOnlyFinal,staleDatabaseCounter,databaseAheadOfAvailableRollout,files:fileRows});
}
const grouped={};
for(const row of rows){if(row.missingRaw)continue;const key=[row.matchesLegacy?'legacy-match':'legacy-mismatch',row.matchesResponse?'response-match':'response-mismatch',row.files.some(f=>f.fork)?'fork':'no-fork',row.files.some(f=>f.totalBackwards)?'reset':'no-reset'].join('/');const g=grouped[key]||{threads:0,tokensUsed:0,snapshotTokens:0};g.threads++;g.tokensUsed+=row.tokensUsed;g.snapshotTokens+=row.snapshotTokens||0;grouped[key]=g;}
const report={referenceGeneratedAt:db.referenceGeneratedAt,summary,groups:grouped,threads:rows};
writeFileSync('.lane/codex-db-crosscheck.json',`${JSON.stringify(report,null,2)}\n`);
console.log(JSON.stringify({summary,groups:grouped},null,2));
