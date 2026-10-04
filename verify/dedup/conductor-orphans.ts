/** Independent follow-up after header oracle: missing optional metadata must not hide raw result identities. */
import { DatabaseSync } from '../shared/sqlite.ts';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
process.on('uncaughtException',()=>{ console.error('Conductor validation could not complete a local read.'); process.exitCode=1; });
const hash=(x:string)=>createHash('sha256').update(x).digest('hex').slice(0,12);
const snapshot=JSON.parse(readFileSync(process.argv[2]??'../reference/snapshot-noindex-51ea561.json','utf8'));
const cutoff=Date.parse(snapshot.generatedAt);
const db=new DatabaseSync(join(homedir(),'Library','Application Support','com.conductor.app','conductor.db'),{readOnly:true});
const rows=db.prepare(`select s.id,s.agent_type,s.claude_session_id,s.created_at,s.updated_at
 from sessions s left join workspaces w on w.id=s.workspace_id left join repos r on r.id=w.repository_id
 where w.id is null or r.id is null`).all() as any[];
const byId=new Map(rows.map(r=>[r.id,r]));
const outputs=rows.map(r=>({sessionKey:hash(r.id),provider:r.agent_type,hasProviderId:!!r.claude_session_id,receipts:[] as any[]}));
const outputById=new Map(rows.map((r,i)=>[r.id,outputs[i]!]));
if(rows.length){const messages=db.prepare(`select session_id,created_at,content,full_message from session_messages where session_id in (${rows.map(()=>'?').join(',')})`).iterate(...rows.map(r=>r.id));
for(const item of messages){if(Date.parse(String(item.created_at))>cutoff)continue;const row=byId.get(item.session_id)!;for(const raw of [item.content,item.full_message]){if(typeof raw!=='string')continue;let r:any;try{r=JSON.parse(raw);}catch{continue;}if(!r||r.type!=='result')continue;const n=(x:any)=>typeof x==='number'&&Number.isFinite(x)&&x>=0?x:0;
const tokenFields=['input_tokens','cache_read_input_tokens','cache_creation_input_tokens','output_tokens'];
const usage=Object.fromEntries(tokenFields.map(k=>[k,n(r.usage?.[k])]));
outputById.get(item.session_id)!.receipts.push({providerKey:typeof r.session_id==='string'?hash(`${row.agent_type}:${r.session_id}`):null,registeredMatches:r.session_id===row.claude_session_id,recordedAt:new Date(String(item.created_at)).toISOString(),month:String(item.created_at).slice(0,7),reportedUsd:n(r.total_cost_usd),localUsage:usage,totalPhysicalTokens:Object.values(usage).reduce((a,b)=>a+b,0),models:Object.keys(r.modelUsage??{}),presentInReference:snapshot.sessions.some((s:any)=>s.sessionKey===hash(`${row.agent_type}:${r.session_id}`))});}}
}
const result={generatedAt:snapshot.generatedAt,orphanRows:rows.length,orphansWithResults:outputs.filter(r=>r.receipts.length).length,rows:outputs};
writeFileSync('.lane/conductor-orphans.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({orphanRows:result.orphanRows,orphansWithResults:result.orphansWithResults,evidence:outputs.filter(r=>r.receipts.length)},null,2));
