// Raw provider projection used after the first independent oracle exposed scope ambiguity.
// Output consists solely of hashed keys, SDK enums, timestamps, model IDs and numbers.
import { DatabaseSync } from '../shared/sqlite.ts';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

try {
const hash = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0,12);
const time = (value) => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const tokens = (u, keys) => Object.fromEntries(keys.map((key)=>[key,number(u?.[key])]));
const usageFields=['input_tokens','cache_read_input_tokens','cache_creation_input_tokens','output_tokens'];
const modelFields=['inputTokens','cacheReadInputTokens','cacheCreationInputTokens','outputTokens','costUSD','contextWindow'];
const safeModel=(model)=>/^claude-[a-z0-9.-]+(?:\[1m\])?$/.test(model)?model:'<unknown>';
const snapshot=JSON.parse(readFileSync(`${homedir()}/session-analytics-lanes/reference/snapshot-noindex-51ea561.json`,'utf8'));
const db=new DatabaseSync(`${homedir()}/Library/Application Support/com.conductor.app/conductor.db`,{readOnly:true});
const projected=[];
const rows=db.prepare("SELECT s.id,s.claude_session_id,s.created_at,MAX(m.created_at) AS last_message_at FROM sessions s LEFT JOIN session_messages m ON m.session_id=s.id WHERE s.agent_type='claude' GROUP BY s.id").all();
const query=db.prepare(`SELECT id,created_at,
  json_extract(content,'$.type') AS type,json_extract(content,'$.subtype') AS subtype,
  json_extract(content,'$.uuid') AS uuid,json_extract(content,'$.session_id') AS provider_id,
  json_extract(content,'$.new_conversation_id') AS new_id,
  json_extract(content,'$.claude_code_version') AS version,
  json_extract(content,'$.total_cost_usd') AS cost,json_extract(content,'$.modelUsage') AS models,
  json_extract(content,'$.usage') AS usage,json_extract(content,'$.message.usage') AS assistant_usage
  FROM session_messages WHERE session_id=? AND json_valid(content) AND
  (json_extract(content,'$.type') IN ('result','conversation_reset','assistant') OR
   (json_extract(content,'$.type')='system' AND json_extract(content,'$.subtype')='init'))
  ORDER BY created_at,id`);
for(const row of rows){
  const entry={sessionKey:hash(row.id),providerKey:row.claude_session_id?hash(`claude:${row.claude_session_id}`):null,
    createdAt:time(row.created_at),lastMessageAt:time(row.last_message_at),events:[]};
  let assistantRecordsSinceInit=0,positiveAssistantUsageSinceInit=0;
  for(const e of query.iterate(row.id)){
    if(e.type==='assistant'){
      assistantRecordsSinceInit++;
      const u=tokens(JSON.parse(e.assistant_usage??'null'),usageFields);
      if(Object.values(u).some(n=>n>0))positiveAssistantUsageSinceInit++;
      continue;
    }
    const event={type:e.type==='system'?'init':e.type,at:time(e.created_at),key:hash(e.uuid??`message:${e.id}`),providerKey:e.provider_id?hash(`claude:${e.provider_id}`):null};
    if(event.type==='init'){
      event.version=typeof e.version==='string'&&/^\d+\.\d+\.\d+$/.test(e.version)?e.version:null;
      assistantRecordsSinceInit=0;positiveAssistantUsageSinceInit=0;
    }
    if(event.type==='conversation_reset')event.newProviderKey=e.new_id?hash(`claude:${e.new_id}`):null;
    if(event.type==='result'){
      event.assistantRecordsSinceInit=assistantRecordsSinceInit;
      event.positiveAssistantUsageSinceInit=positiveAssistantUsageSinceInit;
      event.costUsd=number(e.cost);event.reason=['success','error_during_execution','error_max_turns','error_max_budget_usd','error_max_structured_output_retries'].includes(e.subtype)?e.subtype:'unknown';
      event.usage=tokens(JSON.parse(e.usage??'null'),usageFields);
      event.models=Object.fromEntries(Object.entries(JSON.parse(e.models??'{}')).map(([name,u])=>[safeModel(name),tokens(u,modelFields)]));
    }
    entry.events.push(event);
  }
  projected.push(entry);
}
db.close();
writeFileSync('.lane/conductor-evidence.json',JSON.stringify({generatedAt:new Date().toISOString(),referenceGeneratedAt:snapshot.generatedAt,sessions:projected},null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({sessions:projected.length,events:projected.reduce((sum,s)=>sum+s.events.length,0)}));
} catch {
  console.error("Conductor reconciliation could not read or validate its inputs.");
  process.exitCode = 1;
}
