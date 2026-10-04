/** Second, independent raw pass. Preserve iteration evidence even when visible output resets.
 * No production imports. Source paths and raw identities remain in memory only.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { DatabaseSync } from '../shared/sqlite.ts';
const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0,12);
const reference=JSON.parse(fs.readFileSync(process.argv[2] || '../reference/snapshot-noindex-51ea561.json','utf8'));
const referenceByKey=new Map(reference.sessions.map(s=>[s.sessionKey,s]));
const cutoff=Date.parse(reference.generatedAt);
const {rates}=JSON.parse(fs.readFileSync('verify/pricing/official-rates.json','utf8'));
const identities=new Map(); let conductorAvailable=false;
try {
 const db=new DatabaseSync(path.join(os.homedir(),'Library/Application Support/com.conductor.app/conductor.db'),{readOnly:true});
 for(const r of db.prepare('SELECT id, claude_session_id FROM sessions WHERE claude_session_id IS NOT NULL').iterate()) {
  const key=hash(r.id); if(referenceByKey.has(key))identities.set(r.claude_session_id,key);
 }
 db.close(); conductorAvailable=true;
} catch { /* Do not expose local error strings. */ }
const roots=[];
for(const e of fs.readdirSync(os.homedir(),{withFileTypes:true})) if(e.isDirectory()&&(e.name==='.claude'||e.name.startsWith('.claude-')))roots.push(path.join(os.homedir(),e.name,'projects'));
roots.push(path.join(os.homedir(),'.config/claude/projects'),path.join(os.homedir(),'Library/Application Support/Claude/local-agent-mode-sessions'));
if(process.env.CLAUDE_CONFIG_DIR)roots.push(path.join(process.env.CLAUDE_CONFIG_DIR,'projects'));
const files=[],visited=new Set();
function discover(location) {
 let st;try{st=fs.statSync(location);}catch{return;}
 if(st.isDirectory()){for(const entry of fs.readdirSync(location))discover(path.join(location,entry));return;}
 if(!location.endsWith('.jsonl'))return;
 const real=fs.realpathSync(location);if(visited.has(real))return;visited.add(real);files.push(real);
}
for(const root of roots)discover(root); files.sort();
const safeModel=x=>typeof x==='string'&&/^(?:claude-[a-z0-9.-]+(?:\[1m\])?|<synthetic>)$/.test(x)?x:'<unknown>';
const finite=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0?x:0;
const types=new Set(['message','fallback_message','compaction','advisor','advisor_tool','advisor_tool_use']);
const knownType=x=>types.has(x)?x:'unknown';
function counters(u={}) {
 const five=finite(u.cache_creation?.ephemeral_5m_input_tokens),hour=finite(u.cache_creation?.ephemeral_1h_input_tokens);
 const aggregateWrite=finite(u.cache_creation_input_tokens),write=Math.max(aggregateWrite,five+hour),input=finite(u.input_tokens),read=finite(u.cache_read_input_tokens),output=finite(u.output_tokens);
 return {input,read,write,five,hour,output,aggregateWrite,inputTokens:input+read+write};
}
function project(r, sequence) {
 const m=r.message,u=m.usage,t=Date.parse(r.timestamp),c=counters(u);
 const iterations=Array.isArray(u.iterations)?u.iterations.map(v=>({type:knownType(v.type),model:v.model==null?null:safeModel(v.model),...counters(v)})):[];
 return {sequence,timestamp:Number.isFinite(t)?new Date(t).toISOString():null,model:safeModel(m.model),...c,iterations,
  fallbackCredit:typeof u.fallback_credit==='number'?u.fallback_credit:null,
  fallbackCreditPresent:u.fallback_credit!==undefined,
  stopReason:['end_turn','tool_use','max_tokens','stop_sequence','refusal','pause_turn','model_context_window_exceeded'].includes(m.stop_reason)?m.stop_reason:null};
}
function fingerprint(r){return JSON.stringify({model:r.model,...countersFromProjection(r),iterations:r.iterations,fallbackCredit:r.fallbackCredit});}
function countersFromProjection(r){return Object.fromEntries(['input','read','write','five','hour','output','inputTokens'].map(k=>[k,r[k]]));}
function rank(r){return [r.iterations.length,r.iterations.reduce((a,i)=>a+i.output,0),Date.parse(r.timestamp)||0,r.sequence];}
function richer(a,b){const ar=rank(a),br=rank(b);for(let i=0;i<ar.length;i++){if(ar[i]!==br[i])return ar[i]>br[i];}return false;}
const groups=new Map();
let records=0,assistantRecords=0,usageRecords=0,malformed=0,missingMessageId=0,filesRead=0;
for(const file of files){
 const parts=file.split(path.sep),sub=parts.lastIndexOf('subagents'),identity=sub<0?path.basename(file,'.jsonl'):parts[sub-1];
 let group=groups.get(identity);if(!group){group={identity,last:0,files:0,messages:new Map()};groups.set(identity,group);}group.files++;
 const lines=readline.createInterface({input:fs.createReadStream(file),crlfDelay:Infinity});
 for await(const line of lines){
  let r;try{r=JSON.parse(line);}catch{malformed++;continue;}records++;
  const t=Date.parse(r.timestamp);if(Number.isFinite(t))group.last=Math.max(group.last,t);
  if(r.type!=='assistant'||!r.message||typeof r.message!=='object')continue;assistantRecords++;
  if(!r.message.usage||typeof r.message.usage!=='object')continue;usageRecords++;
  if(typeof r.message.id!=='string'){missingMessageId++;continue;}
  const row=project(r,records);let message=group.messages.get(r.message.id);
  if(!message){message={key:hash('claude-message:'+r.message.id),records:0,maxOutput:row,richest:row,latest:row,interesting:new Map()};group.messages.set(r.message.id,message);}
  message.records++;
  // This is the earlier oracle/analyzer boundary being tested, retained as an independent comparator.
  if(row.output>=message.maxOutput.output)message.maxOutput=row;
  if(richer(row,message.richest))message.richest=row;
  if((Date.parse(row.timestamp)||0)>=(Date.parse(message.latest.timestamp)||0))message.latest=row;
  if(row.iterations.length>1||row.iterations.some(i=>i.type!=='message')){
   const signature=fingerprint(row),prior=message.interesting.get(signature);
   if(prior)prior.duplicates++;else message.interesting.set(signature,{row,duplicates:1});
  }
 }
 filesRead++;if(filesRead%250===0)process.stderr.write(JSON.stringify({progressFiles:filesRead,totalFiles:files.length,records})+'\n');
}
function price(model,c){
 const r=rates[model?.replace(/\[1m\]$/,'')];if(!r)return null;
 const unsplit=Math.max(0,c.write-c.five-c.hour);
 if([r.input,r.cacheRead,r.cacheWrite5m,r.cacheWrite1h,r.output].some(v=>typeof v!=='number'))return null;
 return (c.input*r.input+c.read*r.cacheRead+(c.five+unsplit)*r.cacheWrite5m+c.hour*r.cacheWrite1h+c.output*r.output)/1e6;
}
function expected(r){
 const fallback=r.iterations.some(i=>i.type==='fallback_message');
 const uncertainties=[];let totalUsd=0,inputTokens=0,outputTokens=0;
 const attempts=[];
 for(const i of r.iterations){
  if(i.type==='unknown')uncertainties.push('unknown-iteration-type');
  if(fallback&&i.output===0)uncertainties.push('preoutput-refusal-eligibility');
  if(i.type.startsWith('advisor')&&!i.model)uncertainties.push('advisor-model-unavailable');
  if(fallback&&!i.model&&i.type==='message')uncertainties.push('primary-model-unavailable');
  const model=i.model||r.model,usd=price(model,i);
  if(usd===null)uncertainties.push('unpriced-iteration-model');
  if(i.write>i.five+i.hour)uncertainties.push('iteration-write-ttl-unavailable');
  totalUsd+=usd||0;inputTokens+=i.inputTokens;outputTokens+=i.output;
  attempts.push({...i,model,usd});
 }
 return {totalUsd,inputTokens,outputTokens,uncertainties:[...new Set(uncertainties)],attempts};
}
const messages=[],scopeCounts={},allTypes={},stableTypes={};let stableGroups=0,liveGroups=0,unmatchedGroups=0,matchedMessages=0;
for(const g of groups.values()){
 const sessionKey=identities.get(g.identity)||hash('claude:'+g.identity),s=referenceByKey.get(sessionKey);
 const scope=g.last>cutoff?'continued-after-reference':!s||s.provider!=='claude'?'unmatched':s.costBasis!=='api-list-price-equivalent'?'provider-reported':'matched-stable-api';
 if(scope==='matched-stable-api')stableGroups++;else if(scope==='continued-after-reference')liveGroups++;else unmatchedGroups++;
 for(const m of g.messages.values()){
  if(scope==='matched-stable-api')matchedMessages++;
  if(!m.interesting.size)continue;
  scopeCounts[scope]=(scopeCounts[scope]||0)+1;
  const retained=m.maxOutput,rich=m.richest,latest=m.latest,oracle=expected(rich),base=price(retained.model,retained);
  const oldHasSameIterationEvidence=JSON.stringify(retained.iterations)===JSON.stringify(rich.iterations);
  for(const t of new Set(rich.iterations.map(i=>i.type))){allTypes[t]=(allTypes[t]||0)+1;if(scope==='matched-stable-api')stableTypes[t]=(stableTypes[t]||0)+1;}
  messages.push({sessionKey,messageKey:m.key,scope,month:(rich.timestamp||'undated').slice(0,7),snapshotRecords:m.records,uniqueInterestingSnapshots:m.interesting.size,
   topOutputDropsAfterPrimary:rich.output<retained.output,oldHasSameIterationEvidence,
   maxOutputSnapshot:{timestamp:retained.timestamp,model:retained.model,...countersFromProjection(retained),iterations:retained.iterations,baselineUsd:base},
   richestSnapshot:{timestamp:rich.timestamp,model:rich.model,...countersFromProjection(rich),iterations:oracle.attempts,fallbackCredit:rich.fallbackCredit,fallbackCreditPresent:rich.fallbackCreditPresent,stopReason:rich.stopReason},
   latestSnapshot:{timestamp:latest.timestamp,model:latest.model,...countersFromProjection(latest),iterationCount:latest.iterations.length},
   expectedUsd:oracle.totalUsd,deltaUsd:base===null?null:oracle.totalUsd-base,inputTokensDelta:oracle.inputTokens-retained.inputTokens,outputTokensDelta:oracle.outputTokens-retained.output,
   uncertainties:oracle.uncertainties,
   snapshots:[...m.interesting.values()].map(({row:r,duplicates})=>({timestamp:r.timestamp,model:r.model,...countersFromProjection(r),iterations:r.iterations,duplicates}))});
 }
}
const stable=messages.filter(m=>m.scope==='matched-stable-api'),confirmed=stable.filter(m=>m.uncertainties.length===0&&m.deltaUsd!==null);
function aggregate(rows,keyFn){const result={};for(const m of rows){const key=keyFn(m),v=result[key]||={messages:0,deltaUsd:0,inputTokensDelta:0,outputTokensDelta:0};v.messages++;v.deltaUsd+=m.deltaUsd||0;v.inputTokensDelta+=m.inputTokensDelta;v.outputTokensDelta+=m.outputTokensDelta;}return result;}
const result={oracleVersion:1,referenceGeneratedAt:reference.generatedAt,conductorAvailable,files:files.length,records,assistantRecords,usageRecords,malformed,missingMessageId,
 stableGroups,liveGroups,unmatchedGroups,matchedMessages,scopeCounts,allTypes,stableTypes,
 summary:{stableInterestingMessages:stable.length,confirmedMessages:confirmed.length,affectedStableSessions:new Set(confirmed.map(m=>m.sessionKey)).size,
  hiddenIterationEvidenceMessages:stable.filter(m=>!m.oldHasSameIterationEvidence).length,outputResetMessages:stable.filter(m=>m.topOutputDropsAfterPrimary).length,
  deltaUsd:confirmed.reduce((a,m)=>a+m.deltaUsd,0),inputTokensDelta:confirmed.reduce((a,m)=>a+m.inputTokensDelta,0),outputTokensDelta:confirmed.reduce((a,m)=>a+m.outputTokensDelta,0),
  hiddenAdditionalUsd:confirmed.filter(m=>!m.oldHasSameIterationEvidence).reduce((a,m)=>a+m.deltaUsd,0),uncertainMessages:stable.length-confirmed.length},
 bySession:aggregate(confirmed,m=>m.sessionKey),byMonth:aggregate(confirmed,m=>m.month),messages,
 limitations:['Message and session identities are hashed; source IDs/paths are in-memory only.','Richest candidate ranks iteration count then summed iteration output, timestamp and observation order; alternative snapshots are retained as numeric evidence.','Fallback preoutput refusal eligibility and missing advisor/primary model are left uncertain.','Repeated streamed snapshots are deduplicated, never summed.','Standard current official rates only; selected historical changes and service tiers require separate evidence.','Unsplit cache-write TTL uses five-minute value but is classified uncertain.']};
fs.writeFileSync('.lane/pricing-claude-boundary.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({...result,messages:undefined,bySession:undefined,byMonth:undefined},null,2));
