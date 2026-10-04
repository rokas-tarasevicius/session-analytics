// Independent numeric inventory of non-Claude Conductor result envelopes.
// These counters are NOT added to native provider totals: identities/evidence overlap.
import { DatabaseSync } from '../shared/sqlite.ts';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

try {
const hash=x=>createHash('sha256').update(String(x)).digest('hex').slice(0,12);
const n=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0?x:null;
const time=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))?new Date(x).toISOString():null;
const model=x=>typeof x==='string'&&/^(?:gpt|claude|composer|gemini|cursor|grok|o[134])[-a-z0-9._]*(?:\[1m\])?$/.test(x)?x:'<unknown>';
const allowed=['input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens','reasoning_tokens'];
const snapshot=JSON.parse(readFileSync(`${homedir()}/session-analytics-lanes/reference/snapshot-noindex-51ea561.json`,'utf8'));
const references=new Map(snapshot.sessions.map(s=>[s.sessionKey,s]));
const db=new DatabaseSync(`${homedir()}/Library/Application Support/com.conductor.app/conductor.db`,{readOnly:true});
const last=new Map(db.prepare('SELECT session_id,MAX(created_at) AS last_at FROM session_messages GROUP BY session_id').all().map(r=>[r.session_id,time(r.last_at)]));
const groups=new Map(),inventory={resultRows:0,stableResultRows:0,costPresentRows:0,modelUsagePresentRows:0,byParentProvider:{}};
for(const r of db.prepare(`SELECT m.session_id,m.created_at,s.agent_type,
  json_extract(m.content,'$.session_id') AS provider_id,json_extract(m.content,'$.usage') AS usage,
  json_extract(m.content,'$.total_cost_usd') AS cost,json_extract(m.content,'$.modelUsage') AS model_usage,
  json_extract(m.content,'$.conductor_sdk_metadata.model') AS model,
  json_extract(m.content,'$.conductor_sdk_metadata.modelProvider') AS model_provider
  FROM session_messages m LEFT JOIN sessions s ON s.id=m.session_id
  WHERE (s.agent_type IS NULL OR s.agent_type!='claude') AND json_valid(m.content) AND json_extract(m.content,'$.type')='result'
  ORDER BY m.session_id,m.created_at`).iterate()){
  inventory.resultRows++;
  const parent=['codex','cursor'].includes(r.agent_type)?r.agent_type:'orphan';
  const provider=parent==='orphan'&&r.model_provider==='openai'?'codex':parent;
  const tally=inventory.byParentProvider[parent]??={resultRows:0,costPresentRows:0,modelUsagePresentRows:0,usagePresentRows:0};tally.resultRows++;
  if(r.usage)tally.usagePresentRows++;
  if(n(r.cost)!==null){tally.costPresentRows++;inventory.costPresentRows++;}if(r.model_usage){tally.modelUsagePresentRows++;inventory.modelUsagePresentRows++;}
  const sessionKey=hash(r.session_id),providerKey=r.provider_id?hash(`${provider}:${r.provider_id}`):null,key=providerKey??sessionKey;
  const ref=references.get(sessionKey)??references.get(providerKey);
  const g=groups.get(key)??{sessionKey,providerKey,parentProvider:parent,provider,referenceSessionKey:ref?.sessionKey??null,
    referenceCostUsd:ref?.cost.totalUsd??null,referenceInputTokens:ref?.tokens.inputTokens??null,referenceOutputTokens:ref?.tokens.outputTokens??null,
    lastMessageAt:last.get(r.session_id),excludedLive:(last.get(r.session_id)??'')>snapshot.generatedAt,
    resultRecords:0,costPresentRows:0,modelUsagePresentRows:0,models:new Set(),usageShapes:new Set(),rawUsageSums:Object.fromEntries(allowed.map(k=>[k,0])),months:{},receipts:[]};
  g.resultRecords++;
  if(n(r.cost)!==null)g.costPresentRows++;if(r.model_usage)g.modelUsagePresentRows++;
  const u=JSON.parse(r.usage??'{}'),numeric=Object.fromEntries(allowed.filter(k=>n(u[k])!==null).map(k=>[k,u[k]]));
  const shape=Object.keys(numeric).sort().join(',');g.usageShapes.add(shape);g.models.add(model(r.model));
  const at=time(r.created_at);
  if(!at)continue;
  if(!g.excludedLive&&at<=snapshot.generatedAt){inventory.stableResultRows++;for(const [k,v]of Object.entries(numeric))g.rawUsageSums[k]+=v;const month=at.slice(0,7),bucket=g.months[month]??={results:0,...Object.fromEntries(allowed.map(k=>[k,0]))};bucket.results++;for(const [k,v]of Object.entries(numeric))bucket[k]+=v;}
  g.receipts.push({at,costUsd:n(r.cost),model:model(r.model),usage:numeric});groups.set(key,g);
}
db.close();
const sessions=[...groups.values()].map(g=>({...g,models:[...g.models],usageShapes:[...g.usageShapes]}));
const categories=Object.fromEntries(Object.entries(Object.groupBy(sessions,g=>g.parentProvider)).map(([provider,rows])=>[provider,{sessions:rows.length,stableSessions:rows.filter(s=>!s.excludedLive).length,matchedSessions:rows.filter(s=>s.referenceSessionKey&&!s.excludedLive).length,resultRows:rows.reduce((n,s)=>n+s.resultRecords,0),costPresentRows:rows.reduce((n,s)=>n+s.costPresentRows,0),modelUsagePresentRows:rows.reduce((n,s)=>n+s.modelUsagePresentRows,0)}]));
writeFileSync('.lane/conductor-other-providers.json',JSON.stringify({referenceGeneratedAt:snapshot.generatedAt,method:'Raw result usage sums are an independent observation ledger, not assumed additive usage totals; native sessions remain canonical. Codex input includes cache-read; orphan provider inferred only from modelProvider=openai.',inventory,categories,sessions},null,2)+'\n',{mode:0o600});console.log(JSON.stringify({inventory,categories},null,2));
} catch {
  console.error("Conductor reconciliation could not read or validate its inputs.");
  process.exitCode = 1;
}
