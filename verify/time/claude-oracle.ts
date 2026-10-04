/** Independent raw Claude time oracle. No production imports; exports contain counters only. */
import { createReadStream, existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from '../shared/sqlite.ts';
import { fileURLToPath } from 'node:url';

type Counter = { requests: number; inputTokens: number; cachedInputTokens: number; cacheWrite5mInputTokens: number; cacheWrite1hInputTokens: number; outputTokens: number; totalUsd: number; pricedRequests: number };
type Request = { model: string; first: number | null; last: number | null; fields: number[]; records: number; crossedDay: boolean; crossedMonth: boolean; firstObserved: number | null; modelChanges: number; counterRevisions: number; thinkingExposed: boolean };
type Session = { id: string; cwd: string | null; first: number | null; last: number | null; malformed: number; missingTimestamp: number; invalidTimestamp: number; offsetTimestamp: number; zTimestamp: number; offsetFreeTimestamp: number; backwards: number; files: number; requests: Map<string, Request> };
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 12);
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
const instant = (value: unknown): number | null => typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const iso = (value: number | null) => value === null ? null : new Date(value).toISOString();
const utc = (value: number) => new Date(value).toISOString().slice(0,10);
const londonFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year:'numeric',month:'2-digit',day:'2-digit' });
const london = (value: number) => londonFormat.format(new Date(value));
const empty = (): Counter => ({requests:0,inputTokens:0,cachedInputTokens:0,cacheWrite5mInputTokens:0,cacheWrite1hInputTokens:0,outputTokens:0,totalUsd:0,pricedRequests:0});
function accumulate(a: Counter,b: Counter) { for (const key of Object.keys(a) as (keyof Counter)[]) a[key]+=b[key]; }
function add(map: Record<string, Counter>, key: string, value: Counter) { accumulate(map[key] ??= empty(),value); }
// JSONL is LF-framed. Node 24 readline also splits legal JSON string U+2028/2029.
async function* jsonLines(file:string):AsyncGenerator<string>{let pending='';for await(const chunk of createReadStream(file,{encoding:'utf8'})){pending+=chunk;let boundary:number;while((boundary=pending.indexOf('\n'))>=0){yield pending.slice(0,boundary);pending=pending.slice(boundary+1);}}if(pending.length)yield pending;}
function filesBelow(root:string, depth=0):string[] { if(depth>12 || !existsSync(root))return [];const output:string[]=[];try { for(const e of readdirSync(root,{withFileTypes:true})){const f=path.join(root,e.name);if(e.isDirectory())output.push(...filesBelow(f,depth+1));else if(e.isFile()&&e.name.endsWith('.jsonl'))output.push(f);} } catch {} return output; }
export async function buildClaudeTimeOracle(options: {home?: string; cutoff?: string}={}) {
 const home=options.home??homedir();const cutoff=options.cutoff??(process.env.ORACLE_CUTOFF ?? '2026-10-03T12:17:26.745Z');const rates=JSON.parse(readFileSync(new URL('../../data/rate-cards.json',import.meta.url),'utf8')).models;
 const roots=readdirSync(home).filter(n=>/^\.claude(?:$|[-_])/.test(n)).map(n=>path.join(home,n,'projects'));
 roots.push(path.join(home,'.config/claude/projects'),path.join(home,'Library/Application Support/Claude/local-agent-mode-sessions'));
 if(process.env.CLAUDE_CONFIG_DIR)roots.push(path.join(process.env.CLAUDE_CONFIG_DIR,'projects'));
 const files=[...new Set(roots.flatMap(r=>filesBelow(r)).map(f=>realpathSync(f)))].sort();
 const dbMap=new Map<string,string[]>();let conductorRows=0;let legacyRows:{id:string;created_at:string;workspace_path:string}[]=[];
 const dbPath=path.join(home,'Library/Application Support/com.conductor.app/conductor.db');
 if(existsSync(dbPath)){const db=new DatabaseSync(dbPath,{readOnly:true});try{for(const row of db.prepare('SELECT id, claude_session_id FROM sessions WHERE claude_session_id IS NOT NULL').all() as {id:string;claude_session_id:string}[]){conductorRows++;const list=dbMap.get(row.claude_session_id)??[];list.push(row.id);dbMap.set(row.claude_session_id,list);}legacyRows=db.prepare("SELECT s.id,s.created_at,w.workspace_path FROM sessions s JOIN workspaces w ON w.id=s.workspace_id WHERE s.claude_session_id IS NULL AND s.agent_type='claude' ORDER BY s.created_at DESC").all() as {id:string;created_at:string;workspace_path:string}[];}finally{db.close();}}
 const sessions=new Map<string,Session>();let records=0,unidentifiedFiles=0,malformedRecords=0;
 for(const file of files){let session:Session|undefined;let previous:number|null=null;let sequence=0;const seenSessionFiles=new Set<string>();
   for await(const line of jsonLines(file)){if(!line.trim())continue;records++;sequence++;let r:any;try{r=JSON.parse(line)}catch{malformedRecords++;continue;}
    const id=typeof r.sessionId==='string'?r.sessionId:undefined;if(id){session=sessions.get(id);if(!session){session={id,cwd:null,first:null,last:null,malformed:0,missingTimestamp:0,invalidTimestamp:0,offsetTimestamp:0,zTimestamp:0,offsetFreeTimestamp:0,backwards:0,files:0,requests:new Map()};sessions.set(id,session)}if(!seenSessionFiles.has(id)){session.files++;seenSessionFiles.add(id);}}
    if(!session)continue;if(session.cwd===null&&typeof r.cwd==='string')session.cwd=r.cwd;
    const t=instant(r.timestamp);if(t===null){if(r.timestamp===undefined)session.missingTimestamp++;else session.invalidTimestamp++;}else{session.first=session.first===null?t:Math.min(session.first,t);session.last=session.last===null?t:Math.max(session.last,t);if(typeof r.timestamp==='string'){if(r.timestamp.endsWith('Z'))session.zTimestamp++;else if(/[+-]\d{2}:?\d{2}$/.test(r.timestamp))session.offsetTimestamp++;else session.offsetFreeTimestamp++;}if(previous!==null&&t<previous)session.backwards++;previous=t;}
    if(r.type!=='assistant'||!r.message?.usage)continue;
    const m=r.message;const u=m.usage;const model=typeof m.model==='string'&&/^[a-zA-Z0-9_.:-]{1,128}$/.test(m.model)?m.model:'unknown';
    const cacheTotal=finite(u.cache_creation_input_tokens);const oneHour=finite(u.cache_creation?.ephemeral_1h_input_tokens);const fiveMinute=finite(u.cache_creation?.ephemeral_5m_input_tokens);
    const fields=[finite(u.input_tokens),finite(u.cache_read_input_tokens),fiveMinute||Math.max(0,cacheTotal-oneHour),oneHour,finite(u.output_tokens)];
    const requestId=typeof m.id==='string'?m.id:`${file}:${sequence}`;let request=session.requests.get(requestId);
    if(!request){request={model,first:t,last:t,fields,records:1,crossedDay:false,crossedMonth:false,firstObserved:t,modelChanges:0,counterRevisions:0,thinkingExposed:typeof u.output_tokens_details?.thinking_tokens==='number'};session.requests.set(requestId,request)}else{request.records++;if(request.model!==model)request.modelChanges++;if(request.fields.some((v,i)=>i<4&&v!==fields[i]))request.counterRevisions++;const hasThinking=typeof u.output_tokens_details?.thinking_tokens==='number';if(fields[4]!>request.fields[4]!||(fields[4]===request.fields[4]&&hasThinking&&!request.thinkingExposed)){request.fields=fields;request.model=model;request.thinkingExposed=hasThinking;}if(t!==null){request.first=request.first===null?t:Math.min(request.first,t);request.last=request.last===null?t:Math.max(request.last,t);}if(request.model==='unknown')request.model=model;}
   }
   if(!seenSessionFiles.size)unidentifiedFiles++;
 }
 let legacyMappedSessions=0;for(const row of legacyRows){const created=Date.parse(row.created_at.endsWith('Z')?row.created_at:row.created_at+'Z');const matches=[...sessions.values()].filter(s=>!dbMap.has(s.id)&&s.cwd!==null&&path.resolve(s.cwd)===path.resolve(row.workspace_path)&&s.first!==null&&Math.abs(s.first-created)<=15*60_000);if(matches.length===1){dbMap.set(matches[0]!.id,[row.id]);legacyMappedSessions++;}}
 const output=[];const unknownModels:Record<string,Counter>={};const totals=empty();const dailyUtc:Record<string,Counter>={};const dailyLondon:Record<string,Counter>={};const lastDailyUtc:Record<string,Counter>={};let liveSessions=0;
 for(const s of sessions.values()){
   const mapped=dbMap.get(s.id)??[];const sessionKey=hash(mapped[0]??`claude:${s.id}`);const live=s.last!==null&&s.last>Date.parse(cutoff);if(live)liveSessions++;
   const byUtc:Record<string,Counter>={};const byLondon:Record<string,Counter>={};const byLastUtc:Record<string,Counter>={};const byModel:Record<string,Counter>={};const total=empty();const undated=empty();let duplicateRecords=0,crossDayRequests=0,crossMonthRequests=0,modelChangeRequests=0,counterRevisionRequests=0,earlierTimestampRequests=0;const streamCrossings: unknown[]=[];
   for(const q of s.requests.values()){if(q.fields.every(v=>v===0))continue;if(q.modelChanges)modelChangeRequests++;if(q.counterRevisions)counterRevisionRequests++;if(q.first!==null&&q.firstObserved!==null&&q.first<q.firstObserved)earlierTimestampRequests++;let rate=rates[q.model];if(!rate&&q.model==='claude-haiku-4-5')rate=rates['claude-haiku-4-5-20251001'];if(!rate)rate=rates[q.model.replace(/-\d{8}$/,'')];const [input,read,write5,write1,out]=q.fields as [number,number,number,number,number];
     const usd=rate?(input*rate.inputPerMillion+read*rate.cacheReadPerMillion+write5*rate.cacheWrite5mPerMillion+write1*rate.cacheWrite1hPerMillion+out*rate.outputPerMillion)/1e6:0;
     const c:Counter={requests:1,inputTokens:input+read+write5+write1,cachedInputTokens:read,cacheWrite5mInputTokens:write5,cacheWrite1hInputTokens:write1,outputTokens:out,totalUsd:usd,pricedRequests:rate?1:0};
     accumulate(total,c);add(byModel,q.model,c);duplicateRecords+=q.records-1;
     if(!rate)add(unknownModels,q.model,c);
     if(q.first!==null){add(byUtc,utc(q.first),c);add(byLondon,london(q.first),c);}else accumulate(undated,c);
     if(q.last!==null)add(byLastUtc,utc(q.last),c);
     if(q.first!==null&&q.last!==null){if(utc(q.first)!==utc(q.last)){crossDayRequests++;streamCrossings.push({first:iso(q.first),last:iso(q.last),firstObserved:iso(q.firstObserved),totalUsd:usd,tokens:input+read+write5+write1+out});}if(utc(q.first).slice(0,7)!==utc(q.last).slice(0,7))crossMonthRequests++;}
   }
   output.push({sessionKey,alternateSessionKeys:mapped.slice(1).map(hash),provider:'claude',firstEventAt:iso(s.first),lastEventAt:iso(s.last),live,files:s.files,total,undated,byUtc,byLondon,byLastUtc,byModel,duplicateRecords,crossDayRequests,crossMonthRequests,modelChangeRequests,counterRevisionRequests,earlierTimestampRequests,streamCrossings,anomalies:{missingTimestamp:s.missingTimestamp,invalidTimestamp:s.invalidTimestamp,offsetTimestamp:s.offsetTimestamp,zTimestamp:s.zTimestamp,offsetFreeTimestamp:s.offsetFreeTimestamp,backwards:s.backwards}});
   if(!live){accumulate(totals,total);for(const [k,v]of Object.entries(byUtc))add(dailyUtc,k,v);for(const [k,v]of Object.entries(byLondon))add(dailyLondon,k,v);for(const [k,v]of Object.entries(byLastUtc))add(lastDailyUtc,k,v);}
 }
 return {format:'time-claude-oracle-v1',cutoff,files:files.length,records,unidentifiedFiles,malformedRecords,conductorRows,legacyMappedSessions,liveSessions,totals,dailyUtc,dailyLondon,lastDailyUtc,unknownModels,sessions:output.sort((a,b)=>a.sessionKey.localeCompare(b.sessionKey))};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){buildClaudeTimeOracle().then(result=>{writeFileSync('.lane/time-claude-oracle.json',JSON.stringify(result,null,2));console.log(JSON.stringify({files:result.files,records:result.records,sessions:result.sessions.length,liveSessions:result.liveSessions,totals:result.totals,unknownModels:Object.keys(result.unknownModels)}));}).catch(()=>{console.error('Claude oracle failed; raw error suppressed.');process.exitCode=1;});}
