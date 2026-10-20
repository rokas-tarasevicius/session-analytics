// Independent raw-format oracle. Does not import any production analyzer module.
import {createReadStream} from 'node:fs';
import {readdir,realpath,readFile,writeFile} from 'node:fs/promises';
// Independent LF framing: CR and Unicode separators inside JSON strings are not records.
async function* lfLines(input){let pending='';for await(const chunk of input){pending+=chunk;let end;while((end=pending.indexOf('\n'))>=0){yield pending.slice(0,end);pending=pending.slice(end+1)}}if(pending)yield pending}
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import path from 'node:path';
const sha=s=>createHash('sha256').update(s).digest('hex').slice(0,12);
function modelId(value){
 if(typeof value!=='string'||value.length>160)return '<unknown>';
 const parts=value.split('/');
 if(parts.length>3||/^(Users|home|private|tmp|var|etc|usr|opt|mnt|Volumes|Library)$/i.test(parts[0]))return '<unknown>';
 if(parts.some(part=>part!=='@cf'&&(!/^[A-Za-z][A-Za-z0-9._-]*$/.test(part)||part.includes('..')||/\.(txt|jsonl?|tsx?|jsx?|md|py|log|csv|db|sqlite|pem|key)$/i.test(part)||/^(sk|session|thread|message|msg|request|req|workspace|repository|user|org|proj)[_-]/i.test(part)||/^(gh[pousr]_|github_pat_|xox[baprs]-|AIza)/.test(part)||/[a-f0-9]{24,}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i.test(part))))return '<unknown>';
 return value;
}
const fields=['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens','cache_write_input_tokens'];
const vec=u=>fields.map(k=>Number.isFinite(u?.[k])&&u[k]>=0?u[k]:0);
const sum=(a,b)=>a.map((v,i)=>v+b[i]);
const nonzero=a=>a[0]+a[2]>0;
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const zero=()=>[0,0,0,0,0];
const refPath=process.env.CODEX_ORACLE_REFERENCE??path.resolve('../reference/snapshot-noindex-51ea561.json');
const ref=JSON.parse(await readFile(refPath,'utf8'));
const cutoff=Date.parse(ref.generatedAt);
const out=path.resolve('.lane/codex-observations.json');
const roots=new Set();
let homes=(await readdir(homedir(),{withFileTypes:true})).filter(d=>d.name==='.codex'||d.name.startsWith('.codex-')).map(d=>path.join(homedir(),d.name));
if(process.env.CODEX_HOME)homes.push(process.env.CODEX_HOME);
if(process.env.CODEX_ORACLE_ROOT)homes=[process.env.CODEX_ORACLE_ROOT];
for(const h of homes)for(const subdir of ['sessions','archived_sessions'])try{roots.add(await realpath(path.join(h,subdir)))}catch{}
const files=[];for(const root of roots)for(const e of await readdir(root,{recursive:true,withFileTypes:true}))if(e.isFile()&&e.name.endsWith('.jsonl'))files.push(path.join(e.parentPath,e.name));
files.sort();
const observations=[];const sessions=[];let stats={files:files.length,malformed:0,usageRecords:0,tokenCounts:0,cacheWritePositive:0,unknownModel:0};
let fileIndex=0;
for(const file of files){
 let id=null,model=null,modelObserved=false,metaAt=null,parent=null,fork=null,active=null,turn=null,source=null,lineNo=0,lastResponse=-Infinity,lastResponseAt=null,maxAt=-Infinity,lastTotal=null,metaCount=0,lastTokenLine=-Infinity,lastActivityAt=null,lastActivityType=null;
 const pending=[],metas=[],modelList=new Set(),turnModels=new Map(),compactionResponses=[];let currentSource=null,firstParent=null,firstFork=null,discovery=null;let localUsage=zero(),lastUsage=zero(),maximum=zero();let compactions=0;
 try{
 for await(const line of lfLines(createReadStream(file,{encoding:'utf8'}))){
  lineNo++;let r;try{r=JSON.parse(line)}catch{if(line.trim())stats.malformed++;continue}
  if(!r||typeof r!=='object'||Array.isArray(r)){stats.malformed++;continue;}
  const p=r.payload??{},t=Date.parse(r.timestamp);if(Number.isFinite(t))maxAt=Math.max(maxAt,t);
  if(r.type==='session_meta'){
   const raw=p.id??p.session_id;if(typeof raw==='string'){id=sha('codex:'+raw);active=id;}metaAt=p.timestamp??r.timestamp;metaCount++;
   fork=typeof p.forked_from_id==='string'?sha('codex:'+p.forked_from_id):fork;
   const spawn=p.source?.subagent?.thread_spawn;parent=typeof spawn?.parent_thread_id==='string'?sha('codex:'+spawn.parent_thread_id):parent;
   source=typeof p.source==='string'&&['exec','vscode','cli','review','appServer','app_server'].includes(p.source)?p.source:p.source&&typeof p.source==='object'&&p.source.subagent?'subagent':'unknown';if(!metas.length){const name=path.basename(file).match(/([0-9a-f]{8}-[0-9a-f-]{27})(?:_[0-9a-f]{8}-[0-9a-f-]{27})?\.jsonl$/i)?.[1];discovery={validIdentity:typeof p.id==='string'&&!!p.id,hasWorkingDirectory:typeof p.cwd==='string'&&!!p.cwd,filenameMatches:!!name&&sha('codex:'+name)===id};firstParent=parent;firstFork=fork;currentSource=source}else if(id===metas[0].id)currentSource=source;metas.push({id,at:metaAt,recordAt:r.timestamp,line:lineNo,source});continue;
  }
  if(r.type==='turn_context'){if(Object.hasOwn(p,'model')){modelObserved=true;model=modelId(p.model);modelList.add(model)}if(typeof p.turn_id==='string')turn=sha(p.turn_id);if(turn)turnModels.set(turn,model);continue;}
  if(r.type==='compacted'){compactions++;if(typeof p.compaction_response_id==='string')compactionResponses.push(sha(p.compaction_response_id));}
  if(r.type==='token_usage_record'||(r.type==='event_msg'&&p.type==='token_usage_record')||(r.type==='response_item'&&(['function_call','custom_tool_call','reasoning'].includes(p.type)||(p.type==='message'&&p.role==='assistant')))||(r.type==='event_msg'&&['agent_message','agent_reasoning'].includes(p.type))||(r.type==='event_msg'&&p.type==='item_completed'&&p.item?.type==='AgentMessage')){lastResponse=lineNo;lastResponseAt=r.timestamp;}
  if(!(r.type==='event_msg'&&p.type==='token_count')&&Number.isFinite(t)){lastActivityAt=r.timestamp;lastActivityType=r.type==='event_msg'?p.type:r.type;}
  if(r.type==='event_msg'&&p.type==='task_started'&&typeof p.turn_id==='string')turn=sha(p.turn_id);
  if(r.type==='token_usage_record'||(r.type==='event_msg'&&p.type==='token_usage_record')){
   stats.usageRecords++;const u=vec(p.usage);if(u[4])stats.cacheWritePositive++;if(!model)stats.unknownModel++;
   pending.push({kind:'response',active,at:r.timestamp,model,modelObserved,source,currentSource,exposed:{reasoning:Number.isFinite(p.usage?.reasoning_output_tokens),cached:Number.isFinite(p.usage?.cached_input_tokens)},validUsage:Number.isFinite(p.usage?.input_tokens)&&p.usage.input_tokens>=0&&Number.isFinite(p.usage?.output_tokens)&&p.usage.output_tokens>=0,hasThreadTotal:!!p.thread_token_usage,turn:typeof p.turn_id==='string'?sha(p.turn_id):turn,thread:typeof p.thread_id==='string'?sha('codex:'+p.thread_id):null,response:typeof p.response_id==='string'?sha(p.response_id):null,u,threadTotal:vec(p.thread_token_usage),turnTotal:vec(p.turn_token_usage),line:lineNo});localUsage=sum(localUsage,u);continue;
  }
  if(r.type==='event_msg'&&p.type==='token_count'&&p.info){
   stats.tokenCounts++;const total=vec(p.info.total_token_usage),u=vec(p.info.last_token_usage),delta=lastTotal?sub(total,lastTotal):null;
   const signature=sha(JSON.stringify([total,u]));
   pending.push({kind:'legacy',active,at:r.timestamp,model,modelObserved,source,currentSource,exposed:{reasoning:Number.isFinite(p.info.last_token_usage?.reasoning_output_tokens),cached:Number.isFinite(p.info.last_token_usage?.cached_input_tokens),totalReasoning:Number.isFinite(p.info.total_token_usage?.reasoning_output_tokens),totalCached:Number.isFinite(p.info.total_token_usage?.cached_input_tokens)},hasTotal:!!p.info.total_token_usage,turn,total,u,signature,delta,localResponse:lastResponse>lastTokenLine,responseGap:Number.isFinite(lastResponse)?lineNo-lastResponse:null,responseAt:lastResponseAt,activityAt:lastActivityAt,activityType:lastActivityType,line:lineNo});
   lastTotal=total;lastTokenLine=lineNo;lastUsage=sum(lastUsage,u);maximum=maximum.map((v,i)=>Math.max(v,total[i]));
  }
 }
 }catch{stats.readErrors=(stats.readErrors??0)+1;}
 if(!id){stats.missingIdentity=(stats.missingIdentity??0)+1;fileIndex++;continue;}
 id=metas[0]?.id??id;metaAt=metas[0]?.at??metaAt;source=metas[0]?.source??source;
 const live=maxAt>cutoff;
 sessions.push({key:id,file:fileIndex,live,metaAt,parent,fork,source,discovery,firstParent,firstFork,finalModel:model,modelObserved,turnModels:[...turnModels],compactionResponses,metaCount,metas,modelList:[...modelList],maxAt:Number.isFinite(maxAt)?new Date(maxAt).toISOString():null,compactions,localUsage,lastUsage,maximum});
 for(const p of pending)observations.push({...p,key:id,file:fileIndex,live});
 fileIndex++;if(fileIndex%500===0)console.error(JSON.stringify({scanned:fileIndex,total:files.length}));
}
await writeFile(out,JSON.stringify({generatedAt:ref.generatedAt,stats,sessions,observations}));
console.log(JSON.stringify({phase:'independent_raw_projection',...stats,sessions:sessions.length,observations:observations.length,liveFiles:sessions.filter(s=>s.live).length,uniqueThreads:new Set(sessions.map(s=>s.key)).size,forkFiles:sessions.filter(s=>s.fork).length,subagentFiles:sessions.filter(s=>s.parent).length,multipleMetaFiles:sessions.filter(s=>s.metaCount>1).length}));
