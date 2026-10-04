/** Independent native-response identity audit. LF framing; no production imports. */
import { readFileSync, readdirSync, existsSync, realpathSync, writeFileSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from '../shared/sqlite.ts';
process.on('uncaughtException',()=>{process.stderr.write('Native response identity audit failed; local details suppressed.\n');process.exit(1);});
const hash=(s:string)=>createHash('sha256').update(s).digest('hex').slice(0,12);
const home=homedir(), cutoff=(process.env.ORACLE_CUTOFF ?? '2026-10-03T12:17:26.745Z');
const cache=JSON.parse(readFileSync('.lane/codex-observations.json','utf8'));
const reference=JSON.parse(readFileSync(join(home,'session-analytics-lanes/reference/snapshot-noindex-51ea561.json'),'utf8'));
const referenceSessions=new Map(reference.sessions.filter((s:any)=>s.provider==='codex').map((s:any)=>[s.sessionKey,s]));
const db=new DatabaseSync(join(home,'Library/Application Support/com.conductor.app/conductor.db'),{readOnly:true});
const registered=new Map<string,string>();for(const r of db.prepare("SELECT id,claude_session_id FROM sessions WHERE agent_type='codex'").all() as any[])if(r.claude_session_id)registered.set(r.claude_session_id,hash(r.id));db.close();
const sessionKey=(id:string)=>registered.get(id)??hash('codex:'+id);
const wanted=new Set<string>(cache.requestRecords.map((r:any)=>r.sessionKey));
const roots=new Set<string>(), files:string[]=[];
function walk(root:string){for(const e of readdirSync(root,{withFileTypes:true})){const path=join(root,e.name);if(e.isDirectory())walk(path);else if(e.isFile()&&e.name.endsWith('.jsonl'))files.push(path);}}
for(const directory of readdirSync(home).filter(s=>s==='.codex'||s.startsWith('.codex-')).map(s=>join(home,s)).concat(process.env.CODEX_HOME?[process.env.CODEX_HOME]:[]))for(const leaf of ['sessions','archived_sessions']){const root=join(directory,leaf);if(existsSync(root)){const actual=realpathSync(root);if(!roots.has(actual)){roots.add(actual);walk(actual);}}}
const eventKind=(r:any)=>{const text=String(r.type??'')+':'+String(r.payload?.type??'')+(r.payload?.role?':'+String(r.payload.role):'');return /^[A-Za-z0-9_:-]{1,100}$/.test(text)?text:'unknown';};
function firstIdentity(file:string):string|null{const fd=openSync(file,'r');try{let pending='';const block=Buffer.alloc(16384);for(;;){const bytes=readSync(fd,block,0,block.length,null);if(bytes===0)return null;pending+=block.subarray(0,bytes).toString('utf8');const end=pending.indexOf('\n');if(end<0)continue;try{const row=JSON.parse(pending.slice(0,end));return row.type==='session_meta'&&typeof row.payload?.id==='string'?row.payload.id:null;}catch{return null;}}}finally{closeSync(fd);}}
const tuples=(u:any)=>[u?.input_tokens??0,u?.cached_input_tokens??0,u?.output_tokens??0,u?.reasoning_output_tokens??0];
const rawNative:any[]=[], compactedIds=new Map<string,Set<string>>(), sessionMeta:any[]=[], targetSequences:any[]=[];const shapes:any={};let readFiles=0;
for(const file of files){const filenameId=/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i.exec(basename(file))?.[1];const id=firstIdentity(file)??filenameId;if(!id||!wanted.has(sessionKey(id)))continue;readFiles++;let activeId=id,firstId:string|null=null,model='<unknown>',lastTime:string|null=null,forked=false;let sequence=0;const sequenceRows:any[]=[];let totalNative=0;const recent:any[]=[];const pending:any[]=[];
 for(const line of readFileSync(file,'utf8').split('\n')){if(!line.trim())continue;sequence++;let r:any;try{r=JSON.parse(line)}catch{continue}const p=r.payload??{};const event={type:eventKind(r),time:r.timestamp??null,sequence};for(const row of pending)if(row.nextEvents.length<4)row.nextEvents.push(event);while(pending[0]?.nextEvents.length>=4)pending.shift();if(typeof r.timestamp==='string'&&Number.isFinite(Date.parse(r.timestamp)))lastTime=lastTime===null||r.timestamp>lastTime?r.timestamp:lastTime;
  if(r.type==='session_meta'){if(typeof p.id==='string'){activeId=p.id;firstId??=p.id;}forked||=typeof p.forked_from_id==='string';}
  if(r.type==='turn_context'&&typeof p.model==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(p.model))model=p.model;
  if(r.type==='compacted'&&typeof p.compaction_response_id==='string'){const key=sessionKey(firstId??id);const ids=compactedIds.get(key)??new Set<string>();ids.add(p.compaction_response_id);compactedIds.set(key,ids);}
  if(r.type==='token_usage_record'){
   totalNative++;const key=sessionKey(firstId??id);const responseId=typeof p.response_id==='string'?p.response_id:null;const threadId=typeof p.thread_id==='string'?p.thread_id:null;
   shapes.native??={recordKeys:Object.keys(r),payloadKeys:Object.keys(p),usageKeys:Object.keys(p.usage??{})};
   rawNative.push({sessionKey:key,threadKey:threadId?sessionKey(threadId):null,threadMatchesFirst:threadId===firstId,threadMatchesActive:threadId===activeId,responseId,responseKey:responseId?hash(responseId):null,time:r.timestamp??null,usage:tuples(p.usage),model,sequence,forked,kind:typeof p.kind==='string'?p.kind:null,filenameMatchesFirst:filenameId===firstId,sourceExistedBeforeReference:statSync(file).birthtime.toISOString()<cutoff&&statSync(file).mtime.toISOString()<cutoff,threadUsage:tuples(p.thread_token_usage),turnUsage:tuples(p.turn_token_usage),cacheWriteTokens:p.usage?.cache_write_input_tokens??0,previousEvents:recent.slice(-4),nextEvents:[]});pending.push(rawNative[rawNative.length-1]);
  }
  recent.push(event);if(recent.length>4)recent.shift();
  if(['f0d05d1c8464','f133f4c745dc'].includes(sessionKey(firstId??id))){if(r.type==='token_usage_record'||r.type==='session_meta'||r.type==='compacted'||r.type==='turn_context'||(r.type==='event_msg'&&['token_count','task_started','task_complete','item_completed'].includes(p.type)))sequenceRows.push({sequence,type:r.type,eventType:p.type??null,time:r.timestamp??null,...(r.type==='token_usage_record'?{responseKey:typeof p.response_id==='string'?hash(p.response_id):null,threadMatchesFirst:p.thread_id===firstId,usage:tuples(p.usage)}:{}),...(r.type==='event_msg'&&p.type==='token_count'?{last:tuples(p.info?.last_token_usage),total:tuples(p.info?.total_token_usage)}:{})});}
 }
 const key=sessionKey(firstId??id);sessionMeta.push({sessionKey:key,lastTime,forked,totalNative});if(sequenceRows.length)targetSequences.push({sessionKey:key,lastTime,forked,records:sequenceRows});
}
const meta=new Map<string,any>();for(const row of sessionMeta){const old=meta.get(row.sessionKey);if(!old||String(row.lastTime)>String(old.lastTime))meta.set(row.sessionKey,row);}const stable=rawNative.filter(r=>meta.get(r.sessionKey)?.lastTime<=cutoff&&referenceSessions.has(r.sessionKey));
const byResponse=new Map<string,any[]>();for(const row of stable){const key=row.responseId??`missing:${row.sessionKey}:${row.sequence}`;const group=byResponse.get(key)??[];group.push(row);byResponse.set(key,group);}
const duplicates=[...byResponse.values()].filter(rows=>rows.length>1).map(rows=>({responseKey:rows[0].responseKey,observations:rows.length,sessions:[...new Set(rows.map(r=>r.sessionKey))],sameThread:rows.every(r=>r.threadKey===rows[0].threadKey),sameUsage:rows.every(r=>JSON.stringify(r.usage)===JSON.stringify(rows[0].usage)),sameTime:rows.every(r=>r.time===rows[0].time)}));
const allNumericStates=new Map<string,any[]>();for(const obs of cache.observations){const group=allNumericStates.get(JSON.stringify(obs.last))??[];group.push(obs);allNumericStates.set(JSON.stringify(obs.last),group);}
const projection=stable.map(({responseId,...r})=>({...r,compactionResponse:responseId!==null&&compactedIds.get(r.sessionKey)?.has(responseId)===true}));
const previousOracle=JSON.parse(readFileSync('.lane/codex-oracle.json','utf8'));
const previousSessions=new Map(previousOracle.sessions.map((s:any)=>[s.sessionKey,s]));
const liveSessions=[...meta.values()].filter(s=>s.lastTime>cutoff&&referenceSessions.has(s.sessionKey)).map(s=>{const reference:any=referenceSessions.get(s.sessionKey);const prior:any=previousSessions.get(s.sessionKey);const byUtcMonth:Record<string,number>={};for(const [day,value]of Object.entries(reference.spendByDay) as [string,number][])byUtcMonth[day.slice(0,7)]=(byUtcMonth[day.slice(0,7)]??0)+value;return{sessionKey:s.sessionKey,lastEventAt:s.lastTime,newlyExcluded:prior?.postReference===false,referenceInputTokens:reference.tokens.inputTokens,referenceCachedInputTokens:reference.tokens.cachedInputTokens,referenceOutputTokens:reference.tokens.outputTokens,referenceValueUsd:reference.cost.totalUsd,referenceByUtcMonthValue:byUtcMonth};});
const output={cutoff,liveSessionKeys:liveSessions.map(s=>s.sessionKey),newLiveSessionKeys:liveSessions.filter(s=>s.newlyExcluded).map(s=>s.sessionKey),liveSessions,readFiles,rawNativeRecords:rawNative.length,stableRecords:stable.length,stableSessions:new Set(stable.map(r=>r.sessionKey)).size,uniqueStableResponseIds:byResponse.size,missingResponseIds:stable.filter(r=>!r.responseId).length,threadMismatchFirst:stable.filter(r=>!r.threadMatchesFirst).length,threadMismatchActive:stable.filter(r=>!r.threadMatchesActive).length,duplicateResponses:duplicates,shapes,targetSequences,native:projection};
writeFileSync('.lane/time-native-codex-audit.json',JSON.stringify(output,null,2));console.log(JSON.stringify({...output,native:undefined,targetSequences:undefined},null,2));
