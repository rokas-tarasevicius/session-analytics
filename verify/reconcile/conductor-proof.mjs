// Rebuild exact zero-turn retained-state witnesses from existing sanitized evidence.
// No provider-store reads, source imports, patched implementation or impact file needed.
import { readFileSync, writeFileSync } from 'node:fs';

try {
  const evidence=JSON.parse(readFileSync('.lane/conductor-evidence.json','utf8'));
  const oracle=JSON.parse(readFileSync('.lane/conductor-aggregates.json','utf8'));
  const oldVersion=v=>typeof v==='string'&&/^2\.1\.\d+$/.test(v)&&Number(v.split('.')[2])<277;
  const time=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))?new Date(x).toISOString():null;
  const proof=[];
  for(const identity of oracle.sessions){
    if(identity.excludedLive||identity.referenceKind!=='conductor-result'||!identity.versions.length||!identity.versions.every(oldVersion))continue;
    if(!/^[0-9a-f]{12}$/.test(identity.sessionKey))throw new Error('Invalid projected key.');
    for(const source of evidence.sessions.filter(s=>identity.sourceSessionKeys.includes(s.sessionKey))){
      const seen=new Map();let init=null;
      for(const receipt of source.events){
        if(receipt.type==='init'){init=receipt;continue;}
        if(receipt.type!=='result'||!Number.isFinite(receipt.costUsd)||receipt.costUsd<=0)continue;
        const state=JSON.stringify([receipt.costUsd,Object.fromEntries(Object.entries(receipt.models).sort(([a],[b])=>a.localeCompare(b)))]);
        const previous=seen.get(state),values=Object.values(receipt.usage);
        const emptyTurn=values.some(v=>typeof v==='number')&&values.every(v=>v===null||v===0);
        if(previous?.init&&init&&previous.init.key!==init.key&&emptyTurn&&receipt.positiveAssistantUsageSinceInit===0){
          const initAt=time(init.at),resultAt=time(receipt.at);
          if(!initAt||!resultAt)throw new Error('Invalid projected timestamp.');
          proof.push({sessionKey:identity.sessionKey,initAt,resultAt,milliseconds:Date.parse(resultAt)-Date.parse(initAt),
            costUsd:receipt.costUsd,assistantRecordsSinceInit:receipt.assistantRecordsSinceInit,
            positiveAssistantUsageSinceInit:receipt.positiveAssistantUsageSinceInit});
        }
        seen.set(state,{init});
      }
    }
  }
  writeFileSync('.lane/conductor-replay-proof.json',JSON.stringify(proof,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({witnesses:proof.length,sessions:new Set(proof.map(r=>r.sessionKey)).size,
    positiveAssistantUsage:proof.reduce((n,r)=>n+r.positiveAssistantUsageSinceInit,0)}));
} catch {
  console.error('Conductor reconciliation could not read or validate its inputs.');
  process.exitCode=1;
}
