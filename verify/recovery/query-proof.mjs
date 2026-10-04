// Independent test of the proposed output-only supplement. No production imports.
import { readFile, writeFile } from 'node:fs/promises';
import { discover, sdkRecords, usage, zero, add, hash, value } from './oracle.mjs';
process.on('uncaughtException', () => { process.stderr.write('Recovery verification failed; private local details withheld.\n'); process.exit(1); });
process.on('unhandledRejection', () => { process.stderr.write('Recovery verification failed; private local details withheld.\n'); process.exit(1); });
const rates = JSON.parse(await readFile('data/rate-cards.json','utf8'));
const oracle = JSON.parse(await readFile('.lane/recovery-oracle.json','utf8'));
const paired = new Map(oracle.pairs.map(p => [p.sessionKey,p]));
const { db,sessions } = await discover();
const output=[];
try { for (const session of sessions.filter(s=>paired.has(hash(s.id)))) {
  const seen=new Set(),groups=new Map(); const row={sessionKey:hash(session.id),receipts:0,matched:0,multiModel:0,inputMismatch:0,outputTokens:0,valueUsd:0,undatedTokens:0};
  for (const r of sdkRecords(db,session.id)) {
    if (r.provider_id && r.provider_id!==session.claude_session_id) continue;
    const id=r.uuid??r.id;if(seen.has(id))continue;seen.add(id);
    if(r.type==='assistant' && !r.parent && r.message_usage){const u=usage(r.message_usage);const key=r.response_id??JSON.stringify([r.model,u.uncached,u.cacheRead,u.cacheWrite]);const old=groups.get(key);if(!old||u.output>old.u.output)groups.set(key,{u,model:r.model,day:r.created_at?.slice(0,10)});}
    if(r.type!=='result')continue;
    row.receipts++;
    const u=usage(r.result_usage??{}),total=zero();for(const g of groups.values())add(total,g.u);
    const models=new Set([...groups.values()].map(g=>g.model)),days=new Set([...groups.values()].map(g=>g.day));
    if(models.size!==1)row.multiModel++;
    else if(!['uncached','cacheRead','cacheWrite'].every(k=>total[k]===u[k])||u.uncached+u.cacheRead+u.cacheWrite===0)row.inputMismatch++;
    else {row.matched++;const delta=Math.max(0,u.output-total.output);row.outputTokens+=delta;row.valueUsd+=value({...usage(),output:delta},[...models][0],rates);if(days.size!==1||days.has(undefined))row.undatedTokens+=delta;}
    groups.clear();
  }
  output.push(row);
}}finally{db.close();}
await writeFile('.lane/query-proof.json',JSON.stringify(output,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({sessions:output.length,...Object.fromEntries(['receipts','matched','multiModel','inputMismatch','outputTokens','valueUsd','undatedTokens'].map(k=>[k,output.reduce((n,r)=>n+r[k],0)]))}));
