// Independent raw-evidence oracle. No imports from src or production rate cards.
// All source identifiers/paths remain in memory. Output is strictly numeric/enum evidence.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { DatabaseSync } from '../shared/sqlite.ts';

const hash = x => crypto.createHash('sha256').update(x).digest('hex').slice(0,12);
const snapshot = JSON.parse(fs.readFileSync(process.argv[2] || '../reference/snapshot-noindex-51ea561.json','utf8'));
const cutoff = Date.parse(snapshot.generatedAt);
const byKey = new Map(snapshot.sessions.map(s => [s.sessionKey,s]));
const idMap = new Map();
let conductorAvailable = false;
try {
  const db = new DatabaseSync(path.join(os.homedir(),'Library/Application Support/com.conductor.app/conductor.db'), {readOnly:true});
  for(const r of db.prepare('SELECT id, claude_session_id FROM sessions WHERE claude_session_id IS NOT NULL').iterate()) {
    const key=hash(r.id); if(byKey.has(key)) idMap.set(r.claude_session_id,key);
  }
  db.close(); conductorAvailable = true;
} catch { /* fixed status only; never print raw exceptions */ }
const roots=[];
for(const ent of fs.readdirSync(os.homedir(),{withFileTypes:true})) {
  if(ent.isDirectory() && (ent.name==='.claude'||ent.name.startsWith('.claude-'))) roots.push(path.join(os.homedir(),ent.name,'projects'));
}
roots.push(path.join(os.homedir(),'.config/claude/projects'));
roots.push(path.join(os.homedir(),'Library/Application Support/Claude/local-agent-mode-sessions'));
if(process.env.CLAUDE_CONFIG_DIR) roots.push(path.join(process.env.CLAUDE_CONFIG_DIR,'projects'));
const files=[], seenFiles=new Set();
function walk(p) {
  let st;try{st=fs.statSync(p);}catch{return;}
  if(st.isDirectory()) { for(const e of fs.readdirSync(p)) walk(path.join(p,e)); }
  else if(p.endsWith('.jsonl')) { const real=fs.realpathSync(p);if(!seenFiles.has(real)){seenFiles.add(real);files.push(real);} }
}
for(const root of roots) walk(root);
files.sort();
const groups = new Map();
const n = x => typeof x==='number' && Number.isFinite(x) && x>=0 ? x : 0;
const modelName = x => typeof x==='string' && /^(?:claude-[a-z0-9.\[\]-]+|<synthetic>)$/.test(x) ? x : '<unknown>';
const enumValue = (x, allowed) => allowed.includes(x)?x:x==null?'absent':'other';
let malformed=0,records=0,assistantRecords=0,usageRecords=0,missingIds=0;
const unexpectedUsageFields=new Set();
for(const file of files) {
  const parts=file.split(path.sep), subIndex=parts.lastIndexOf('subagents');
  const nominalId=subIndex>=0?parts[subIndex-1]:path.basename(file,'.jsonl');
  let group=groups.get(nominalId);
  if(!group) { group={id:nominalId, messages:new Map(),last:0,files:0,records:0};groups.set(nominalId,group); }
  group.files++;
  const rl=readline.createInterface({input:fs.createReadStream(file),crlfDelay:Infinity});
  for await(const line of rl) {
    let r;try{r=JSON.parse(line);}catch{malformed++;continue;}
    records++;group.records++;
    const stamp=Date.parse(r.timestamp);if(Number.isFinite(stamp)) group.last=Math.max(group.last,stamp);
    if(r.type!=='assistant'||!r.message||typeof r.message!=='object')continue;
    assistantRecords++;
    const m=r.message,u=m.usage;if(!u||typeof u!=='object')continue;
    usageRecords++;
    for(const k of Object.keys(u)) if(/^[a-z_]+$/.test(k)) unexpectedUsageFields.add(k);
    const messageId=m.id;
    if(typeof messageId!=='string'){missingIds++;continue;}
    const five=n(u.cache_creation?.ephemeral_5m_input_tokens),hour=n(u.cache_creation?.ephemeral_1h_input_tokens);
    const writes=Math.max(n(u.cache_creation_input_tokens),five+hour);
    const input=n(u.input_tokens),read=n(u.cache_read_input_tokens),output=n(u.output_tokens);
    const row={model:modelName(m.model),timestamp:Number.isFinite(stamp)?new Date(stamp).toISOString():null,
      uncachedInputTokens:input,cachedInputTokens:read,cacheWriteInputTokens:writes,
      cacheWrite5mInputTokens:five,cacheWrite1hInputTokens:hour,inputTokens:input+read+writes,
      outputTokens:output,reasoningOutputTokens:n(u.output_tokens_details?.thinking_tokens),
      speed:enumValue(u.speed,['standard','fast']),serviceTier:enumValue(u.service_tier,['standard','priority','batch','default','auto']),
      inferenceGeo:enumValue(u.inference_geo,['global','us','US','eu','not_available']),subagent:subIndex>=0,
      iterationCount:Array.isArray(u.iterations)?u.iterations.length:0,
      webSearchRequests:n(u.server_tool_use?.web_search_requests),webFetchRequests:n(u.server_tool_use?.web_fetch_requests),
      fallbackCredit:typeof u.fallback_credit==='number'?u.fallback_credit:null,
      iterations:Array.isArray(u.iterations)?u.iterations.map(i=>({
        type:typeof i.type==='string'&&/^[a-z_]{1,30}$/.test(i.type)?i.type:'unknown',
        model:typeof i.model==='string'?modelName(i.model):null,
        input:n(i.input_tokens),read:n(i.cache_read_input_tokens),write:n(i.cache_creation_input_tokens),
        five:n(i.cache_creation?.ephemeral_5m_input_tokens),hour:n(i.cache_creation?.ephemeral_1h_input_tokens),output:n(i.output_tokens),
      })):[],
      aggregateWrites:n(u.cache_creation_input_tokens)};
    const old=group.messages.get(messageId);
    // The format repeats a complete usage snapshot per streamed block; largest output wins.
    if(!old||row.outputTokens>=old.outputTokens) group.messages.set(messageId,row);
  }
}
const tokenFields=['uncachedInputTokens','cachedInputTokens','cacheWriteInputTokens','cacheWrite5mInputTokens','cacheWrite1hInputTokens','inputTokens','outputTokens','reasoningOutputTokens'];
const add=(a,b)=>{for(const f of tokenFields)a[f]=(a[f]||0)+(b[f]||0);return a;};
const requests=[],sessions=[],differences=[],models={},enums={speed:{},serviceTier:{},inferenceGeo:{}};
let matched=0,unmatched=0,live=0,zeroSynthetic=0;
for(const g of groups.values()) {
  const key=idMap.get(g.id)||hash('claude:'+g.id),reference=byKey.get(key);
  if(g.last>cutoff){live++;continue;}
  if(!reference||reference.provider!=='claude'){unmatched++;continue;}
  matched++;
  const tokens={},byModel={};
  for(const r of g.messages.values()) {
    if(r.model==='<synthetic>'&&r.inputTokens+r.outputTokens===0){zeroSynthetic++;continue;}
    requests.push({sessionKey:key,...r});add(tokens,r);add(byModel[r.model]??={calls:0},r);byModel[r.model].calls++;add(models[r.model]??={calls:0},r);models[r.model].calls++;
    for(const e of Object.keys(enums))enums[e][r[e]]=(enums[e][r[e]]||0)+1;
  }
  sessions.push({sessionKey:key,files:g.files,calls:Object.values(byModel).reduce((a,b)=>a+(b.calls||0),0),tokens,models:byModel});
  const delta={};for(const f of tokenFields)if((tokens[f]||0)!==reference.tokens[f])delta[f]=(tokens[f]||0)-reference.tokens[f];
  if(Object.keys(delta).length)differences.push({sessionKey:key,delta,oracle:tokens,reference:reference.tokens});
}
const result={generatedAt:snapshot.generatedAt,independent:true,conductorAvailable,files:files.length,records,assistantRecords,usageRecords,malformed,missingIds,matched,unmatched,live,zeroSynthetic,usageFields:[...unexpectedUsageFields].sort(),models,enums,differences,sessions};
const covered=new Set(sessions.map(s=>s.sessionKey));
const groupByKey=new Map([...groups.values()].map(g=>[idMap.get(g.id)||hash('claude:'+g.id),g]));
const exclusions=snapshot.sessions.filter(s=>s.provider==='claude'&&s.costBasis==='api-list-price-equivalent'&&!covered.has(s.sessionKey)).map(s=>{
  const g=groupByKey.get(s.sessionKey);
  return {sessionKey:s.sessionKey,last:g?.last?new Date(g.last).toISOString():null,files:g?.files||0,referenceUsd:s.cost.totalUsd,
    reason:g?.last>cutoff?'continued-after-reference':g?'identity-or-grouping-unresolved':'no-current-source-match'};
});
fs.writeFileSync('.lane/pricing-claude-raw.json',JSON.stringify(result,null,2)+'\n');
fs.writeFileSync('.lane/pricing-claude-requests.json',JSON.stringify(requests)+'\n');
fs.writeFileSync('.lane/pricing-claude-exclusions.json',JSON.stringify(exclusions,null,2)+'\n');
console.log(JSON.stringify({...result,sessions:undefined,differences:result.differences.slice(0,5)},null,2));
