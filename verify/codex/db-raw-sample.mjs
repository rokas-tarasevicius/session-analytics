#!/usr/bin/env node
// Independent raw-record triangulation for database counter semantics.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from '../shared/sqlite.ts';
import { createInterface } from 'node:readline';
const hash = s => createHash('sha256').update(s).digest('hex').slice(0,12);
const report = JSON.parse(readFileSync('.lane/codex-db-oracle.json','utf8'));
const stable = report.threads.filter(row=>!row.afterCutoff && row.sessionKey);
const selected = new Set([
  ...stable.filter(row=>row.differenceFromSnapshot<0),
  ...stable.filter(row=>row.differenceFromSnapshot>0).sort((a,b)=>b.differenceFromSnapshot-a.differenceFromSnapshot).slice(0,25),
  ...stable.filter(row=>row.differenceFromSnapshot===0).filter((_,i)=>i%100===0),
  ...report.threads.filter(row=>!row.afterCutoff && !row.sessionKey),
].map(row=>row.threadKey));
const dbRows=new Map();
for(const home of new Set(readdirSync(homedir()).filter(n=>/^\.codex(?:-|$)/.test(n)).map(n=>realpathSync(join(homedir(),n))))) {
  for(const name of readdirSync(home).filter(n=>/^state_\d+\.sqlite$/.test(n))) {
    const db=new DatabaseSync(join(home,name),{readOnly:true});
    try {for(const row of db.prepare('SELECT id,rollout_path FROM threads').all())dbRows.set(hash(`codex:${row.id}`),row);}
    finally {db.close();}
  }
}
const numberFields=['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'];
const usage = value => value && typeof value==='object' ? Object.fromEntries(numberFields.filter(key=>typeof value[key]==='number').map(key=>[key,value[key]])) : null;
const rows=[];
for(const threadKey of selected) {
  const raw=dbRows.get(threadKey);
  const base=report.threads.find(row=>row.threadKey===threadKey);
  const row={threadKey,sessionKey:base.sessionKey,tokensUsed:base.tokensUsed,snapshotTokens:base.snapshotTokens,readable:!!raw&&existsSync(raw.rollout_path),
    records:0,malformed:0,metadataCount:0,metadataThreadKeys:[],forkedFromKeys:[],countEvents:0,distinctCountStates:0,
    firstTotal:null,lastTotal:null,maxTotalTokens:0,totalBackwards:0,sumDistinctLastTokens:0,usageRecords:0,usageRecordFieldNames:[],
    firstAt:null,lastAt:null,dbEqualsLastTotal:null,dbEqualsMaxTotal:null};
  if(!row.readable){rows.push(row);continue;}
  const states=new Set();const recordFields=new Set();const meta=new Set();const forks=new Set();
  let previous=0;
  const lines=createInterface({input:createReadStream(raw.rollout_path),crlfDelay:Infinity});
  for await(const line of lines){let event;try{event=JSON.parse(line);}catch{row.malformed++;continue;}row.records++;
    if(typeof event.timestamp==='string' && Number.isFinite(Date.parse(event.timestamp))){const ts=new Date(event.timestamp).toISOString();if(!row.firstAt||ts<row.firstAt)row.firstAt=ts;if(!row.lastAt||ts>row.lastAt)row.lastAt=ts;}
    const p=event.payload;
    if(event.type==='session_meta'){row.metadataCount++;if(typeof p?.id==='string')meta.add(hash(`codex:${p.id}`));if(typeof p?.forked_from_id==='string')forks.add(hash(`codex:${p.forked_from_id}`));}
    if(event.type==='event_msg'&&p?.type==='token_count'&&p.info){row.countEvents++;
      const total=usage(p.info.total_token_usage);const last=usage(p.info.last_token_usage);
      if(total){row.firstTotal??=total;row.lastTotal=total;const t=total.total_tokens??((total.input_tokens||0)+(total.output_tokens||0));if(t<previous)row.totalBackwards++;previous=t;row.maxTotalTokens=Math.max(row.maxTotalTokens,t);}
      const state=JSON.stringify([total,last]);if(!states.has(state)){states.add(state);row.sumDistinctLastTokens+=(last?.total_tokens??((last?.input_tokens||0)+(last?.output_tokens||0)));}
    }
    if(event.type==='token_usage_record'||(event.type==='event_msg'&&p?.type==='token_usage_record')){row.usageRecords++;Object.keys(p||{}).forEach(k=>recordFields.add(k));}
  }
  row.distinctCountStates=states.size;row.metadataThreadKeys=[...meta];row.forkedFromKeys=[...forks];row.usageRecordFieldNames=[...recordFields].sort();
  row.dbEqualsLastTotal=row.tokensUsed===row.lastTotal?.total_tokens;row.dbEqualsMaxTotal=row.tokensUsed===row.maxTotalTokens;rows.push(row);
}
const summary={sampledThreads:rows.length,readable:rows.filter(r=>r.readable).length,dbEqualsLastTotal:rows.filter(r=>r.dbEqualsLastTotal).length,dbEqualsMaxTotal:rows.filter(r=>r.dbEqualsMaxTotal).length,hasBackwards:rows.filter(r=>r.totalBackwards>0).length,hasFork:rows.filter(r=>r.forkedFromKeys.length>0).length,hasUsageRecords:rows.filter(r=>r.usageRecords>0).length};
writeFileSync('.lane/codex-db-raw-sample.json',`${JSON.stringify({method:'All 25 DB-under-snapshot threads, top 25 DB-over-snapshot threads, every 100th exact match, and pre-cutoff absent-snapshot DB threads',summary,threads:rows},null,2)}\n`);
console.log(JSON.stringify({summary,largestExcess:rows.filter(r=>r.snapshotTokens!==null).sort((a,b)=>(b.tokensUsed-b.snapshotTokens)-(a.tokensUsed-a.snapshotTokens)).slice(0,3)},null,2));
