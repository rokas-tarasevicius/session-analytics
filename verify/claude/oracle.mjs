// Independent Claude usage oracle. No production parser/pricing imports.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { lfLines } from '../shared/lf-lines.mjs';
import { DatabaseSync } from '../shared/sqlite.ts';
import { pathToFileURL } from 'node:url';
import { addEvent } from '../shared/event-buckets.ts';

export const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
export const keys = ['inputTokens','uncachedInputTokens','cachedInputTokens','cacheWriteInputTokens','cacheWrite5mInputTokens','cacheWrite1hInputTokens','outputTokens','reasoningOutputTokens','nonReasoningOutputTokens'];
export const zero = () => Object.fromEntries(keys.map(k => [k, 0]));
const num = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
export function counters(u) {
  const five = num(u.cache_creation?.ephemeral_5m_input_tokens);
  const hour = num(u.cache_creation?.ephemeral_1h_input_tokens);
  const write = Math.max(num(u.cache_creation_input_tokens), five + hour);
  const input = num(u.input_tokens), read = num(u.cache_read_input_tokens), output = num(u.output_tokens);
  const reasoning = num(u.output_tokens_details?.thinking_tokens);
  const thinkingKnown=typeof u.output_tokens_details?.thinking_tokens==='number'&&Number.isFinite(u.output_tokens_details.thinking_tokens)&&u.output_tokens_details.thinking_tokens>=0;
  return {inputTokens:input+read+write,uncachedInputTokens:input,cachedInputTokens:read,cacheWriteInputTokens:write,cacheWrite5mInputTokens:five,cacheWrite1hInputTokens:hour,outputTokens:output,reasoningOutputTokens:reasoning,nonReasoningOutputTokens:thinkingKnown?Math.max(0,output-reasoning):0};
}
export async function files() {
  const home = os.homedir();
  const candidates = (await fsp.readdir(home,{withFileTypes:true})).filter(e=>e.name==='.claude'||e.name.startsWith('.claude-')).map(e=>path.join(home,e.name,'projects'));
  candidates.push(path.join(home,'.config/claude/projects'));
  if(process.env.CLAUDE_CONFIG_DIR)candidates.push(path.join(process.env.CLAUDE_CONFIG_DIR,'projects'));
  candidates.push(path.join(home,'Library/Application Support/Claude/local-agent-mode-sessions'),path.join(home,'Library/Application Support/Claude/claude-code-sessions'));
  const roots = new Set(), result = [];
  for (const candidate of candidates) {
    let root; try { root=await fsp.realpath(candidate); } catch { continue; }
    if(roots.has(root))continue; roots.add(root);
    const profileKey=hash(root),historyProfileKey=path.basename(root)==='projects'?'profile-'+crypto.createHash('sha256').update('claude:directory:'+path.dirname(root)).digest('hex').slice(0,20):null;
    async function walk(dir) {
      for(const e of await fsp.readdir(dir,{withFileTypes:true})) {
        const p=path.join(dir,e.name);
        if(e.isDirectory())await walk(p);
        else if(e.isFile()&&e.name.endsWith('.jsonl')) {
          const rel=path.relative(root,p).split(path.sep), sub=rel.lastIndexOf('subagents');
          const groupId=sub>0?rel[sub-1]:e.name.slice(0,-6);
          result.push({path:p,profileKey,historyProfileKey,groupId,subagent:sub>=0,fileKey:hash(p),desktop:root.includes('local-agent-mode-sessions')});
        }
      }
    }
    await walk(root);
  }
  return result;
}
export function conductorKeys() {
  const result=new Map();
  let db;
  try {
    db=new DatabaseSync(path.join(os.homedir(),'Library/Application Support/com.conductor.app/conductor.db'),{readOnly:true});
    for(const row of db.prepare('SELECT id, claude_session_id, agent_type FROM sessions').all()) {
      if(row.claude_session_id && (!row.agent_type || row.agent_type==='claude')) {
        const list=result.get(row.claude_session_id)??[]; list.push(hash(row.id)); result.set(row.claude_session_id,list);
      }
    }
  } finally {db?.close();}
  return result;
}
const add = (to,from) => {for(const k of keys)to[k]+=from[k];};
const zeroCost=()=>({inputUsd:0,cachedInputUsd:0,cacheWriteUsd:0,outputUsd:0,totalUsd:0,upperEstimateUsd:0});
function bucket() {return {tokens:zero(),costUSD:0,cost:zeroCost(),pricingCoverage:{pricedTokens:0,eligibleTokens:0},calls:0};}
export async function run() {
  const reference=JSON.parse(await fsp.readFile(path.join(os.homedir(),'session-analytics-lanes/reference/snapshot-noindex-51ea561.json'),'utf8'));
  const refSessions=reference.sessions.filter(s=>s.provider==='claude'), refByKey=new Map(refSessions.map(s=>[s.sessionKey,s]));
  const cutoff=reference.generatedAt, mapping=conductorKeys();
  const aliases=JSON.parse(await fsp.readFile('.lane/claude-key-aliases.json','utf8'));
  const groups=new Map(), observations={files:0,records:0,malformed:0,assistantSnapshots:0,usageSnapshots:0,missingMessageId:0,syntheticUsageSnapshots:0,apiErrorUsageSnapshots:0,invalidTimestamps:0,reasoningExceedsOutput:0,cacheSplitExceedsTotal:0};
  const inventory=await files();
  for(const file of inventory) {
    const key=hash('claude:'+file.groupId);
    let g=groups.get(key);
    if(!g){g={key,mainPath:null,metadataTimestamp:null,candidateKeys:[...(mapping.get(file.groupId)??[]),key],profiles:new Set(),historyProfiles:new Set(),messages:new Map(),files:0,mainFiles:0,validIdentity:false,first:null,last:null,compactions:0,summaries:0,sidechainRecords:0,statistics:{}};groups.set(key,g);}
    g.files++;g.profiles.add(file.profileKey);if(file.historyProfileKey)g.historyProfiles.add(file.historyProfileKey);if(!file.subagent){g.mainFiles++;if(!g.mainPath||file.path<g.mainPath)g.mainPath=file.path;}
    const input=fs.createReadStream(file.path),lines=lfLines(input);
    observations.files++;
    for await(const line of lines) {
      if(!line.trim())continue;
      let r; try{r=JSON.parse(line);}catch{observations.malformed++;continue;}
      observations.records++;
      if(!file.subagent&&r.sessionId===file.groupId)g.validIdentity=true;
      const ts=instant(r.timestamp);if(!file.subagent&&ts&&!g.metadataTimestamp)g.metadataTimestamp=ts;
      if(ts){if(!g.first||ts<g.first)g.first=ts;if(!g.last||ts>g.last)g.last=ts;}
      if(r.isSidechain)g.sidechainRecords++;
      if(r.type==='summary')g.summaries++;
      if(r.type==='system'&&r.subtype==='compact_boundary')g.compactions++;
      if(r.type!=='assistant'||!r.message)continue;
      observations.assistantSnapshots++;
      const m=r.message,u=m.usage;
      if(!u||typeof u!=='object')continue;
      observations.usageSnapshots++;
      const t=counters(u),positive=t.inputTokens+t.outputTokens>0;
      if(m.model==='<synthetic>'){if(positive)observations.syntheticUsageSnapshots++;continue;}
      if(r.isApiErrorMessage){if(positive)observations.apiErrorUsageSnapshots++;continue;}
      if(ts&&(!r.isSidechain||file.subagent)&&typeof m.model==='string'&&/^[a-zA-Z0-9._:/<>-]{1,128}$/.test(m.model)&&m.model!=='<unknown>') {
        const tokens=['input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens'].reduce((n,k)=>n+(Number.isSafeInteger(u[k])&&u[k]>=0?u[k]:0),0);
        if(tokens>0&&Number.isSafeInteger(tokens)){const id=ts.slice(0,10)+':'+m.model;const cell=g.statistics[id]??={day:ts.slice(0,10),model:m.model,tokens:0};cell.tokens+=tokens;}
      }
      if(!m.id)observations.missingMessageId++;
      if(!ts)observations.invalidTimestamps++;
      if(t.reasoningOutputTokens>t.outputTokens)observations.reasoningExceedsOutput++;
      if(t.cacheWrite5mInputTokens+t.cacheWrite1hInputTokens>num(u.cache_creation_input_tokens))observations.cacheSplitExceedsTotal++;
      const id=hash(m.id??r.uuid??('missing:'+file.fileKey+':'+observations.records));
      const iterations=Array.isArray(u.iterations)&&u.iterations.length>1?u.iterations.map((v,i)=>({model:typeof v.model==='string'&&/^[a-zA-Z0-9._:/<>-]{1,128}$/.test(v.model)?v.model:m.model,tokens:counters({...v,...(i===u.iterations.length-1&&v.output_tokens===u.output_tokens?{output_tokens_details:u.output_tokens_details}:{})})})):null;
      const obs={thinkingKnown:typeof u.output_tokens_details?.thinking_tokens==='number'&&Number.isFinite(u.output_tokens_details.thinking_tokens),messageKey:id,requestKey:r.requestId?hash(r.requestId):null,model:typeof m.model==='string'&&/^[a-zA-Z0-9._:/<>-]{1,128}$/.test(m.model)?m.model:'<unknown>',tokens:t,timestamp:ts,finalTimestamp:ts,iterations,subagent:file.subagent,fileKey:file.fileKey,sidechain:!!r.isSidechain};
      const old=g.messages.get(id);
      // A stream emits cumulative snapshots for one response. Highest output is final;
      // when equal, prefer the latest timestamp, preserving a deterministic file tie.
      if(old&&ts&&t.inputTokens+t.outputTokens>0&&old.subagent===obs.subagent&&(!old.timestamp||ts<old.timestamp))old.timestamp=ts;
      const samePhysical=old&&['uncachedInputTokens','cachedInputTokens','cacheWriteInputTokens'].every(k=>old.tokens[k]===t[k]);
      const richer=samePhysical&&(t.reasoningOutputTokens>old.tokens.reasoningOutputTokens||t.cacheWrite5mInputTokens+t.cacheWrite1hInputTokens>old.tokens.cacheWrite5mInputTokens+old.tokens.cacheWrite1hInputTokens);
      if(!old||t.outputTokens>old.tokens.outputTokens||(t.outputTokens===old.tokens.outputTokens&&(richer||obs.thinkingKnown&&!old.thinkingKnown||old.tokens.inputTokens+old.tokens.outputTokens===0&&t.inputTokens+t.outputTokens>0))) {
        // docs/metrics.md Calendar and attribution: first positive snapshot owns
        // the request time; completion may fall on another day or month.
        if(old&&old.tokens.inputTokens+old.tokens.outputTokens>0&&old.subagent===obs.subagent)obs.timestamp=old.timestamp??ts;
        g.messages.set(id,obs);
      }
    }
  }
  // All accounting above is independent of production. Pricing is a separate oracle.
  const {price}=await import('./pricing.mjs');
  const sessions=[],ignored=[],unmatched=[];
  const owners=new Map(),duplicateOwnership=[];
  for(const g of [...groups.values()].filter(g=>g.validIdentity).sort((a,b)=>(a.metadataTimestamp??'\uffff').localeCompare(b.metadataTimestamp??'\uffff')||(a.mainPath??'').localeCompare(b.mainPath??'')))for(const m of g.messages.values()){
    const old=owners.get(m.messageKey),t=m.tokens,o=old?.message.tokens;
    const same=o&&['uncachedInputTokens','cachedInputTokens','cacheWriteInputTokens'].every(k=>o[k]===t[k]);
    const richer=same&&(t.reasoningOutputTokens>o.reasoningOutputTokens||t.cacheWrite5mInputTokens+t.cacheWrite1hInputTokens>o.cacheWrite5mInputTokens+o.cacheWrite1hInputTokens);
    if(old&&old.group!==g.key)duplicateOwnership.push({messageKey:m.messageKey,firstGroup:old.group,nextGroup:g.key});
    if(!old||t.outputTokens>o.outputTokens||t.outputTokens===o.outputTokens&&(richer||m.thinkingKnown&&!old.message.thinkingKnown||o.inputTokens+o.outputTokens===0&&t.inputTokens+t.outputTokens>0))owners.set(m.messageKey,{group:g.key,message:m});
  }
  const globalMessages=new Map();
  for(const g of groups.values()) {
    const sessionKey=g.candidateKeys.find(k=>refByKey.has(k))??aliases[g.key]??g.key;
    if(g.last&&g.last>cutoff){ignored.push({sessionKey,reason:'activity-after-reference',files:g.files,lastObservedAt:g.last,snapshotTokens:refByKey.get(sessionKey)?.tokens??null,snapshotUsd:refByKey.get(sessionKey)?.cost.totalUsd??null});continue;}
    if(!g.validIdentity){unmatched.push({sessionKey,reason:g.mainFiles?'no-matching-main-identity':'subagent-only',files:g.files,calls:g.messages.size});continue;}
    const s={sessionKey,profileKeys:[...g.profiles].sort(),historyProfileKeys:[...g.historyProfiles].sort(),files:g.files,firstEventAt:g.first,lastEventAt:g.last,tokens:zero(),costUSD:0,cost:zeroCost(),pricingCoverage:{pricedTokens:0,eligibleTokens:0},models:{},spendByDay:{},tokensByDay:{},costByExecution:{topLevelUsd:0,subagentUsd:0},historyStatistics:Object.values(g.statistics),calls:0,compactions:g.compactions,summaries:g.summaries,sidechainRecords:g.sidechainRecords};
    const eventBuckets=new Map();
    for(const m of g.messages.values()) {
      if(m.tokens.inputTokens+m.tokens.outputTokens===0||owners.get(m.messageKey)?.group!==g.key)continue;
      const list=globalMessages.get(m.messageKey)??[];list.push({sessionKey,tokens:m.tokens,model:m.model,timestamp:m.timestamp,subagent:m.subagent,requestKey:m.requestKey});globalMessages.set(m.messageKey,list);
      for(const call of m.iterations??[m]) {
      const t=call.tokens;
      const p=price(call.model,{input:t.uncachedInputTokens,cacheRead:t.cachedInputTokens,cacheWrite5m:t.cacheWrite5mInputTokens,cacheWrite1h:t.cacheWrite1hInputTokens,cacheWriteUnknown:Math.max(0,t.cacheWriteInputTokens-t.cacheWrite5mInputTokens-t.cacheWrite1hInputTokens),output:t.outputTokens,reasoning:t.reasoningOutputTokens},m.timestamp);
      const cost=p.costUSD;
      addEvent(eventBuckets,{at:m.timestamp,model:call.model,executionKind:m.subagent?'subagent':'top-level',tokens:t,totalUsd:cost,calls:1},reference.velocity?.timeZone??'Europe/London');
      add(s.tokens,t);s.costUSD+=cost;s.calls++;
      const mod=s.models[call.model]??=bucket();add(mod.tokens,t);mod.costUSD+=cost;mod.calls++;
      for(const target of [s,mod]){target.pricingCoverage.eligibleTokens+=t.inputTokens+t.outputTokens;target.pricingCoverage.pricedTokens+=p.pricedTokens;}
      const component={inputUsd:p.inputUSD,cachedInputUsd:p.cacheReadUSD,cacheWriteUsd:p.cacheWriteUSD,outputUsd:p.outputUSD,totalUsd:cost,upperEstimateUsd:cost};for(const k of Object.keys(component)){s.cost[k]+=component[k];mod.cost[k]+=component[k];}
      s.costByExecution[m.subagent?'subagentUsd':'topLevelUsd']+=cost;
      if(m.timestamp){const d=m.timestamp.slice(0,10);s.spendByDay[d]=(s.spendByDay[d]??0)+cost;add(s.tokensByDay[d]??=zero(),t);}
      }
    }
    s.eventBuckets=[...eventBuckets.values()];
    sessions.push(s);
  }
  const diffs=[],missingReference=[],monthly={},monthlyCohorts={},profiles={},models={},repositories={};
  const roll=(map,key,oracle,ref)=>{const b=map[key]??={oracle:bucket(),reference:bucket(),sessions:0};add(b.oracle.tokens,oracle.tokens);b.oracle.costUSD+=oracle.costUSD;b.oracle.calls+=oracle.calls??0;if(ref){add(b.reference.tokens,ref.tokens??ref);b.reference.costUSD+=ref.costUSD??ref.cost?.totalUsd??ref.totalUsd??0;b.reference.calls+=ref.calls??ref.metrics?.modelCalls??0;}b.sessions++;};
  for(const s of sessions){
    const r=refByKey.get(s.sessionKey);
    if(!r){missingReference.push(s.sessionKey);continue;}
    const delta=Object.fromEntries(keys.map(k=>[k,r.tokens[k]-s.tokens[k]]));
    const days=[...new Set([...Object.keys(s.spendByDay),...Object.keys(r.spendByDay)])].sort();
    const dayDelta=Object.fromEntries(days.map(d=>[d,(r.spendByDay[d]??0)-(s.spendByDay[d]??0)]).filter(([,v])=>Math.abs(v)>1e-8));
    const modelDiff={};
    for(const name of new Set([...Object.keys(s.models),...r.models.map(m=>m.model)])){
      const om=s.models[name]??bucket(),rm=r.models.find(m=>m.model===name);
      const dt=Object.fromEntries(keys.map(k=>[k,(rm?.[k]??0)-om.tokens[k]]));
      const dc=(rm?.totalUsd??0)-om.costUSD;
      if(Math.abs(dc)>1e-8||Object.values(dt).some(v=>v))modelDiff[name]={tokens:dt,costUSD:dc};
      roll(models,name,om,rm);
    }
    const dc=r.cost.totalUsd-s.costUSD;
    if(Object.values(delta).some(v=>v)||Math.abs(dc)>1e-8||Object.keys(dayDelta).length||Object.keys(modelDiff).length||s.calls!==r.metrics.modelCalls||s.compactions!==r.metrics.compactions)diffs.push({sessionKey:s.sessionKey,deltaTokens:delta,deltaCostUSD:dc,referenceCostUSD:r.cost.totalUsd,oracleCostUSD:s.costUSD,deltaCalls:r.metrics.modelCalls-s.calls,deltaCompactions:r.metrics.compactions-s.compactions,dayDelta,modelDiff});
    for(const d of days)roll(monthly,d.slice(0,7),{tokens:s.tokensByDay[d]??zero(),costUSD:s.spendByDay[d]??0},{tokens:zero(),costUSD:r.spendByDay[d]??0});
    roll(monthlyCohorts,(s.firstEventAt??'undated').slice(0,7),s,r);
    for(const key of s.profileKeys)roll(profiles,key,s,r);
    roll(repositories,r.repositoryId,s,r);
  }
  const matched=new Set(sessions.map(s=>s.sessionKey)),skip=new Set(ignored.map(s=>s.sessionKey));
  const referenceOnly=refSessions.filter(s=>!matched.has(s.sessionKey)&&!skip.has(s.sessionKey)).map(s=>({sessionKey:s.sessionKey,tokens:s.tokens,costUSD:s.cost.totalUsd,files:s.transcript.files,costBasis:s.costBasis}));
  const duplicates=[...globalMessages.entries()].filter(([,v])=>v.length>1).map(([messageKey,observations])=>({messageKey,observations}));
  // Legacy UTC spend cells do not expose per-token-class counters. Do not turn
  // unavailable reference day tokens into zeros; cohort comparisons retain all classes.
  for(const b of Object.values(monthly)){delete b.reference.tokens;delete b.reference.calls;delete b.oracle.calls;delete b.sessions;}
  const output={version:2,referenceGeneratedAt:cutoff,observations,duplicateOwnership,summary:{referenceSessions:refSessions.length,referenceCostUSD:refSessions.reduce((n,s)=>n+s.cost.totalUsd,0),oracleSessions:sessions.length,matchedSessions:sessions.length-missingReference.length,differingSessions:diffs.length,ignoredSessions:ignored.length,referenceOnlySessions:referenceOnly.length,missingReferenceSessions:missingReference.length,duplicateMessages:duplicates.length},sessions,diffs,ignored,unmatched,missingReference,referenceOnly,monthly,monthlyCohorts,profiles,models,repositories,duplicates};
  await fsp.writeFile('.lane/claude-oracle.json',JSON.stringify(output,null,2)+'\n');
  console.log(JSON.stringify({observations,summary:output.summary}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)run().catch(()=>{console.error('Claude oracle failed; no private exception details emitted.');process.exitCode=1;});
