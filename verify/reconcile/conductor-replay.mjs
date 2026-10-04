// AFTER-oracle source replay; this is a diagnosis harness, not the independent oracle.
// Reconstructs only numerical receipt/init projections in an in-memory database.
import { DatabaseSync } from '../shared/sqlite.ts';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { conductorFallback } from '../../src/providers/conductor.ts';
import { zeroCost } from '../../src/providers/common.ts';

try {
const proposed=(await import(pathToFileURL(process.argv[2]).href)).conductorFallback;
const hash=x=>createHash('sha256').update(x).digest('hex').slice(0,12);
const evidence=JSON.parse(readFileSync('.lane/conductor-evidence.json','utf8'));
const oracle=JSON.parse(readFileSync('.lane/conductor-aggregates.json','utf8'));
const db=new DatabaseSync(':memory:');
db.exec('CREATE TABLE session_messages (id TEXT,session_id TEXT,content TEXT,created_at TEXT)');
const insert=db.prepare('INSERT INTO session_messages VALUES (?,?,?,?)');
const rows=[];
for(const source of evidence.sessions){
  if(source.lastMessageAt>oracle.referenceGeneratedAt)continue;
  rows.push({agent_type:'claude',branch:null,conductor_session_id:source.sessionKey,created_at:source.createdAt,database_model:null,
    default_branch:'main',is_hidden:0,provider_session_id:source.providerKey,repository_id:'synthetic',repository_name:'Example',repository_remote:'',root_path:'/synthetic',status:'completed',title:'',updated_at:source.lastMessageAt??source.createdAt,workspace_name:null,workspace_path:'/synthetic'});
  let eventIndex=0;
  for(const e of source.events){
    if(e.at>oracle.referenceGeneratedAt)continue;
    const ordering=String(eventIndex++).padStart(9,'0');
    const raw={type:e.type==='init'?'system':e.type,uuid:e.key,session_id:e.providerKey};
    if(e.type==='init'){raw.subtype='init';raw.claude_code_version=e.version;}
    if(e.type==='conversation_reset')raw.new_conversation_id=e.newProviderKey;
    if(e.type==='result'){
      if(e.positiveAssistantUsageSinceInit>0)insert.run(`${ordering}-a`,source.sessionKey,JSON.stringify({type:'assistant',message:{usage:{input_tokens:1}}}),e.at);
      raw.subtype=e.reason;raw.total_cost_usd=e.costUsd;
      raw.usage=Object.fromEntries(Object.entries(e.usage).filter(([,v])=>v!==null));
      raw.modelUsage=Object.fromEntries(Object.entries(e.models).map(([name,u])=>[name,Object.fromEntries(Object.entries(u).filter(([,v])=>v!==null))]));
    }
    insert.run(`${ordering}-b`,source.sessionKey,JSON.stringify(raw),e.at);
  }
}
const canonical=new Set(oracle.sessions.filter(s=>s.referenceKind==='canonical').map(s=>`claude:${s.sessionKey}`));
const pricing={rateCard:{currency:'USD',effectiveDate:'2026-01-01',models:{}},price:zeroCost};
const before=conductorFallback(db,rows,canonical,pricing),after=proposed(db,rows,canonical,pricing);
db.close();
const diffs=[];
let sourceReplayReferenceDifference=0;
for(const s of oracle.sessions.filter(s=>!s.excludedLive&&s.referenceKind==='conductor-result')){
  const key=hash(`claude:${s.sessionKey}`),old=before.find(s=>s.sessionKey===key),next=after.find(s=>s.sessionKey===key);
  if(!old||!next)throw new Error('Projection replay unexpectedly lost an identity.');
  sourceReplayReferenceDifference+=Math.abs(old.cost.totalUsd-s.reference.costUsd);
  const oldTokens=old.tokens.inputTokens+old.tokens.outputTokens,newTokens=next.tokens.inputTokens+next.tokens.outputTokens;
  if(Math.abs(old.cost.totalUsd-next.cost.totalUsd)>1e-8||oldTokens!==newTokens)diffs.push({sessionKey:s.sessionKey,month:s.createdAt.slice(0,7),beforeUsd:old.cost.totalUsd,afterUsd:next.cost.totalUsd,removedUsd:old.cost.totalUsd-next.cost.totalUsd,beforeTokens:oldTokens,afterTokens:newTokens,addedTokens:newTokens-oldTokens});
}
const summarize=a=>({sessions:a.length,removedUsd:a.reduce((n,s)=>n+s.removedUsd,0),addedTokens:a.reduce((n,s)=>n+s.addedTokens,0)});
const report={sourceReplayReferenceDifference,summary:summarize(diffs),byMonth:Object.entries(Object.groupBy(diffs,s=>s.month)).map(([month,a])=>({month,...summarize(a)})),changes:diffs};
writeFileSync('.lane/conductor-patch-impact.json',JSON.stringify(report,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({sourceReplayReferenceDifference,summary:report.summary,byMonth:report.byMonth},null,2));
} catch {
  console.error("Conductor reconciliation could not read or validate its inputs.");
  process.exitCode = 1;
}
