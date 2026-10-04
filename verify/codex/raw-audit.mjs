#!/usr/bin/env node
/** Independent schema/identity audit. Reads rollouts only; persisted output is numeric or hashed. */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {createHash} from 'node:crypto';
const cutoff=Date.parse((process.env.ORACLE_CUTOFF ?? '2026-10-03T12:17:26Z'));
const hash=x=>createHash('sha256').update(x).digest('hex').slice(0,12);
const skey=x=>hash('codex:'+x);
const tokenFields=['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'];
const vector=x=>tokenFields.map(k=>typeof x?.[k]==='number'?x[k]:0);
const zero=()=>[0,0,0,0,0,0];
const add=(a,b)=>a.map((v,i)=>v+b[i]);
const count=(o,k,n=1)=>{o[k]=(o[k]||0)+n};
const equal=(a,b)=>a.every((v,i)=>v===b[i]);
let files=[];const visited=new Set();
function walk(p){try{p=fs.realpathSync(p);if(visited.has(p))return;visited.add(p);for(const d of fs.readdirSync(p,{withFileTypes:true})){const q=path.join(p,d.name);if(d.isDirectory())walk(q);else if(d.name.endsWith('.jsonl'))files.push(q)}}catch{}}
for(const d of fs.readdirSync(process.env.HOME,{withFileTypes:true})){if(d.isDirectory()&&d.name.startsWith('.codex'))for(const sub of ['sessions','archived_sessions'])walk(path.join(process.env.HOME,d.name,sub));}
if(process.env.CODEX_HOME)for(const sub of ['sessions','archived_sessions'])walk(path.join(process.env.CODEX_HOME,sub));
files.sort();
const summaries=[];const response=new Map();const tcSignatures=new Map();const stateSignatures=new Map();const counts={files:files.length};const schema={};
for(const file of files){
 const f={hash:hash(file),archived:file.includes('/archived_sessions/'),meta:[],types:{},usage:[],snapshots:[],contexts:new Map(),maxTime:0,minTime:Infinity};
 let model='unknown',turn=null,lineNo=0;
 const input=readline.createInterface({input:fs.createReadStream(file),crlfDelay:Infinity});
 for await(const line of input){lineNo++;if(!line.trim())continue;let x;try{x=JSON.parse(line)}catch{count(counts,'malformedLines');count(f.types,'malformedLines');continue}
  const p=x.payload||{};const type=x.type==='event_msg'?p.type:x.type;
  // Do not persist unknown record type names or arbitrary strings.
  const ts=Date.parse(x.timestamp);if(Number.isFinite(ts)){f.maxTime=Math.max(f.maxTime,ts);f.minTime=Math.min(f.minTime,ts)}
  if(type==='session_meta'){f.meta.push({id:p.id??p.session_id,parent:p.forked_from_id,source:typeof p.source==='string'?(['exec','vscode','cli','review'].includes(p.source)?p.source:'other'):(p.source?.subagent?'subagent':'other'),time:ts});continue}
  if(type==='turn_context'){model=typeof p.model==='string'?p.model:'unknown';turn=p.turn_id||null;if(turn)f.contexts.set(turn,model);count(f.types,'turn_context');continue}
  if(type==='compacted'){count(f.types,'compacted');continue}
  if(type==='token_usage_record'){
   count(f.types,'token_usage_record');count(counts,x.type==='event_msg'?'nestedUsageRecords':'topLevelUsageRecords');
   schema.usageKeys??=Object.keys(p.usage||{});schema.usagePayloadKeys??=Object.keys(p);schema.example??={usage:p.usage,turn_token_usage:p.turn_token_usage,thread_token_usage:p.thread_token_usage};
   f.usage.push({owner:p.thread_id,session:p.session_id,turn:p.turn_id,response:p.response_id,time:ts,usage:vector(p.usage),total:vector(p.thread_token_usage),turnTotal:vector(p.turn_token_usage),model,contextTurn:turn,line:lineNo});continue;
  }
  if(type==='token_count'){
   count(f.types,'token_count');if(!p.info?.total_token_usage){count(f.types,'null_token_count');continue}
   const u=vector(p.info.total_token_usage),last=vector(p.info.last_token_usage);f.snapshots.push({total:u,last,time:ts,model,contextTurn:turn,line:lineNo});continue;
  }
 }
 if(!f.meta.length){count(counts,'filesWithoutMeta');continue}
 const target=f.meta[0].id;const filenameId=path.basename(file).match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.jsonl$/)?.[1];count(counts,filenameId===target?'firstMetaMatchesFilename':'firstMetaMismatchFilename');if(!target){count(counts,'filesWithoutId');continue}
 f.target=target;f.live=f.maxTime>cutoff;f.key=skey(target);f.fork=!!f.meta[0].parent;f.distinctMeta=new Set(f.meta.map(m=>m.id)).size;
 if(f.meta.length>1)count(counts,'multipleMetaFiles');if(f.distinctMeta>1)count(counts,'distinctMetaFiles');if(f.fork)count(counts,'forkFiles');if(f.live)count(counts,'liveFiles');
 for(const u of f.usage){
  if(u.time>cutoff)count(counts,'usageRecordsAfterCutoff');
  if(!u.response)count(counts,'usageMissingResponseId');if(!u.owner)count(counts,'usageMissingThreadId');if(!u.turn)count(counts,'usageMissingTurnId');
  if(!schema.ownerRelation) schema.ownerRelation={};count(schema.ownerRelation,u.owner===target?'ownerMatchesFile':'foreignOwner');count(counts,u.contextTurn===u.turn?'usageMatchesContextTurn':'usageMismatchContextTurn');
  const id=u.response?hash(u.response):hash(JSON.stringify([u.owner,u.turn,u.time,u.usage]));let r=response.get(id);
  if(!r){r={owner:u.owner,usage:u.usage,totals:[],occurrences:[],time:u.time,turn:u.turn};response.set(id,r)}
  if(!equal(r.usage,u.usage))count(counts,'conflictingResponseUsage');if(r.owner!==u.owner)count(counts,'conflictingResponseOwners');
  r.occurrences.push({target,live:f.live,archived:f.archived,model:u.model,contextTurn:u.contextTurn,matchedModel:f.contexts.get(u.turn)||null,line:u.line});r.totals.push(u.total);
 }
 for(const t of f.snapshots){const id=hash(JSON.stringify([t.time,t.total,t.last]));let r=tcSignatures.get(id);if(!r){r={total:t.total,last:t.last,time:t.time,occurrences:[]};tcSignatures.set(id,r)}r.occurrences.push({target,live:f.live,fork:f.fork,archived:f.archived});const sid=hash(JSON.stringify([t.total,t.last]));let state=stateSignatures.get(sid);if(!state){state={total:t.total,last:t.last,occurrences:[]};stateSignatures.set(sid,state)}state.occurrences.push({target,live:f.live,fork:f.fork,archived:f.archived,time:t.time,metaTime:f.meta[0].time,model:t.model});}
 summaries.push(f);
}
const byThread=new Map();function row(id){if(!byThread.has(id))byThread.set(id,{sessionKey:skey(id),files:0,live:false,forks:0,usageRecords:0,ownUsageRecords:0,foreignUsageRecords:0,uniqueOwnedResponses:0,ownResponseTokens:zero(),ownedResponsesObservedOnlyElsewhere:0,ownedResponsesInOwnFile:0,globalResponseTokens:zero(),responseTokensByModel:{},responseTokensByMonth:{},latestThreadTotal:zero(),latestThreadTotalTime:0,models:{},modelJoinMismatch:0,tokenCounts:0,snapshots:0,compacted:0});return byThread.get(id)}
for(const f of summaries){const r=row(f.target);r.files++;r.live||=f.live;r.forks+=f.fork?1:0;r.usageRecords+=f.usage.length;r.ownUsageRecords+=f.usage.filter(u=>u.owner===f.target).length;r.foreignUsageRecords+=f.usage.filter(u=>u.owner!==f.target).length;r.tokenCounts+=f.types.token_count||0;r.snapshots+=f.snapshots.length;r.compacted+=f.types.compacted||0;}
const responseStats={unique:response.size,duplicated:0,crossFile:0,foreignOnly:0,ownAndForeign:0,ownOnly:0,repeatedOwnFile:0,occurrences:0,modelsWithoutContext:0,contextTurnMismatches:0};
for(const r of response.values()){
 responseStats.occurrences+=r.occurrences.length;
 const targets=new Set(r.occurrences.map(o=>o.target));const own=r.occurrences.filter(o=>o.target===r.owner),foreign=r.occurrences.filter(o=>o.target!==r.owner);
 if(r.occurrences.length>1)responseStats.duplicated++;if(targets.size>1)responseStats.crossFile++;if(own.length&&foreign.length)responseStats.ownAndForeign++;else if(own.length)responseStats.ownOnly++;else responseStats.foreignOnly++;
 if(own.length>1)responseStats.repeatedOwnFile++;
 if(!r.owner)continue;const o=row(r.owner);o.uniqueOwnedResponses++;o.globalResponseTokens=add(o.globalResponseTokens,r.usage);if(own.length){o.ownedResponsesInOwnFile++;o.ownResponseTokens=add(o.ownResponseTokens,r.usage)}else o.ownedResponsesObservedOnlyElsewhere++;
 const best=own[0]||r.occurrences[0];const model=best.matchedModel||best.model;count(o.models,model);o.responseTokensByModel[model]=add(o.responseTokensByModel[model]||zero(),r.usage);const month=new Date(r.time).toISOString().slice(0,7);o.responseTokensByMonth[month]=add(o.responseTokensByMonth[month]||zero(),r.usage);if(!best.matchedModel)responseStats.modelsWithoutContext++;if(best.contextTurn!==r.turn){responseStats.contextTurnMismatches++;o.modelJoinMismatch++}
 const maxTotal=r.totals.reduce((a,b)=>b[5]>a[5]?b:a,zero());if(Number.isFinite(r.time)&&r.time>=o.latestThreadTotalTime){o.latestThreadTotal=maxTotal;o.latestThreadTotalTime=r.time}
}
const tcStats={unique:tcSignatures.size,duplicate:0,crossFile:0,crossNonFork:0,crossArchived:0,liveOnly:0,occurrences:0,crossFileHistogram:{},crossFileTokens:zero(),crossFileLast:zero()};
for(const r of tcSignatures.values()){
 const ids=new Set(r.occurrences.map(o=>o.target));const historicalIds=new Set(r.occurrences.filter(o=>!o.live).map(o=>o.target));const nonFork=new Set(r.occurrences.filter(o=>!o.fork).map(o=>o.target));tcStats.occurrences+=r.occurrences.length;
 if(r.occurrences.length>1)tcStats.duplicate++;if(ids.size>1){tcStats.crossFile++;count(tcStats.crossFileHistogram,ids.size);tcStats.crossFileTokens=add(tcStats.crossFileTokens,r.total);tcStats.crossFileLast=add(tcStats.crossFileLast,r.last)}if(nonFork.size>1)tcStats.crossNonFork++;if(r.occurrences.some(o=>o.archived)&&r.occurrences.some(o=>!o.archived))tcStats.crossArchived++;if(!historicalIds.size)tcStats.liveOnly++;
}
const stateStats={unique:stateSignatures.size,duplicate:0,crossFile:0,crossNonFork:0,crossArchived:0,occurrences:0,historicalCrossFile:0,crossFileHistogram:{},crossFileLast:zero(),replayObservations:0,firstMetaSourceMismatch:0};for(const r of stateSignatures.values()){const ids=new Set(r.occurrences.map(o=>o.target));const historicalIds=new Set(r.occurrences.filter(o=>!o.live).map(o=>o.target));const nonFork=new Set(r.occurrences.filter(o=>!o.fork).map(o=>o.target));stateStats.occurrences+=r.occurrences.length;if(r.occurrences.length>1)stateStats.duplicate++;if(ids.size>1){stateStats.crossFile++;count(stateStats.crossFileHistogram,ids.size);stateStats.crossFileLast=add(stateStats.crossFileLast,r.last)}if(historicalIds.size>1)stateStats.historicalCrossFile++;if(nonFork.size>1)stateStats.crossNonFork++;if(r.occurrences.some(o=>o.archived)&&r.occurrences.some(o=>!o.archived))stateStats.crossArchived++;stateStats.replayObservations+=r.occurrences.filter(o=>o.fork&&o.time<o.metaTime).length;}for(const f of summaries)if(f.meta[0].source!==f.meta.at(-1).source)stateStats.firstMetaSourceMismatch++;
const output={cutoff:new Date(cutoff).toISOString(),generatedAt:new Date().toISOString(),tokenFields,counts,schema,responseStats,tcStats,stateStats,files:summaries.map(f=>({fileKey:f.hash,sessionKey:f.key,archived:f.archived,live:f.live,fork:f.fork,metaCount:f.meta.length,distinctMeta:f.distinctMeta,firstSource:f.meta[0].source,lastSource:f.meta.at(-1).source,metaHistory:f.meta.map(m=>({sessionKey:skey(m.id),source:m.source,fork:!!m.parent,time:new Date(m.time).toISOString()})),minTime:Number.isFinite(f.minTime)?new Date(f.minTime).toISOString():null,maxTime:new Date(f.maxTime).toISOString(),types:f.types})),threads:[...byThread.values()].sort((a,b)=>a.sessionKey.localeCompare(b.sessionKey))};
fs.writeFileSync('.lane/codex-raw-audit.json',JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({counts,schema,responseStats,tcStats,stateStats,threads:output.threads.length},null,2));
