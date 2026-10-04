/** Independent metadata-only check for provider-reported Cursor value in Conductor messages. */
import { DatabaseSync } from '../shared/sqlite.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
try {
 const snapshot=JSON.parse(await readFile(process.argv[2]??join(homedir(),'session-analytics-lanes/reference/snapshot-noindex-51ea561.json'),'utf8'));
 const cutoff=Date.parse(snapshot.generatedAt),db=new DatabaseSync(join(homedir(),'Library/Application Support/com.conductor.app/conductor.db'),{readOnly:true});
 const money=new Set(['costInCents','costUSD','costUsd','total_cost_usd','rawCostCents','chargedCents','totalCents','cursorTokenFee','inputUsd','outputUsd']);
 const usage=new Set(['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','totalTokens','reasoningTokens','input_tokens','output_tokens']);
 const excluded=new Set(['args','arguments','input','output','result','text','thinking','content','tool_input','tool_output']);
 const fields:Record<string,{observations:number;positive:number}>={};let rows=0,parsed=0,postCutoff=0,withoutMetadata=0;
 function inspect(value:any,depth=0){if(!value||typeof value!=='object'||depth>10)return;if(Array.isArray(value)){for(const x of value)inspect(x,depth+1);return;}for(const [key,v] of Object.entries(value)){if((money.has(key)||usage.has(key))&&typeof v==='number'&&Number.isFinite(v)){const c=fields[key]??={observations:0,positive:0};c.observations++;c.positive+=Number(v>0);}if(!excluded.has(key))inspect(v,depth+1);}}
 try{for(const row of db.prepare("SELECT m.created_at,m.full_message,m.content FROM session_messages m JOIN sessions s ON m.session_id=s.id WHERE s.agent_type='cursor'").iterate()){
  rows++;if(Date.parse(String(row.created_at))>cutoff){postCutoff++;continue;}
  let found=false;for(const k of ['full_message','content']){const raw=row[k];if(typeof raw!=='string')continue;try{const r=JSON.parse(raw);if(r&&typeof r==='object'){parsed++;found=true;inspect(r)}}catch{}}
  if(!found)withoutMetadata++;
 }}finally{db.close();}
 console.log(JSON.stringify({source:'conductor-cursor-message-metadata',cutoff:snapshot.generatedAt,rows,postCutoff,jsonEnvelopes:parsed,withoutMetadata,fields,scope:'Structured envelopes only; content, arguments and results are not searched for costs. Counts are observations, not summed bills.'},null,2));
}catch{console.error(JSON.stringify({error:'Cursor receipt evidence could not be read.'}));process.exitCode=1;}
