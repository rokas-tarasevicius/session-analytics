/** Independent Codex request-time oracle. No application imports. Never exports paths/content/raw IDs. */
import { readFileSync, readdirSync, existsSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from '../shared/sqlite.ts';

type Usage = { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number };
type Amount = Usage & { valueUsd: number; calls: number };
type Observation = { file: string; key: string; time: string | null; usage: Usage; model: string; score: number; state: string };
type Session = { sessionKey: string; firstEventAt: string | null; lastEventAt: string | null; firstPositiveUsageAt: string | null; localTokenObservations: number; requestRecordCount: number; models: Record<string, Amount>; utc: Record<string, Amount>; london: Record<string, Amount>; undated: Amount; total: Amount; postReference: boolean };
process.on('uncaughtException', () => { process.stderr.write('Codex time verification failed; local details suppressed.\n'); process.exit(1); });
process.on('unhandledRejection', () => { process.stderr.write('Codex time verification failed; local details suppressed.\n'); process.exit(1); });
const hash = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 12);
const nonnegative = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
const usage = (v: any): Usage => ({ inputTokens: nonnegative(v?.input_tokens), cachedInputTokens: nonnegative(v?.cached_input_tokens), outputTokens: nonnegative(v?.output_tokens), reasoningOutputTokens: nonnegative(v?.reasoning_output_tokens) });
const positive = (v: Usage) => v.inputTokens + v.outputTokens > 0;
const amount = (): Amount => ({inputTokens:0,cachedInputTokens:0,outputTokens:0,reasoningOutputTokens:0,valueUsd:0,calls:0});
const absolute = (v: unknown): string | null => typeof v === 'string' && /(?:Z|[+-]\d\d:\d\d)$/i.test(v) && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
const add = (a: Amount, b: Amount) => { for (const k of Object.keys(a) as (keyof Amount)[]) a[k] += b[k]; };
const h = homedir();
const snapshotFile = resolve(process.argv[2] ?? join(h,'session-analytics-lanes/reference/snapshot-noindex-51ea561.json'));
// Only the reference cutoff is consulted before the oracle is finalized.
const referenceTime = absolute(JSON.parse(readFileSync(snapshotFile,'utf8')).generatedAt)!;
const rates = JSON.parse(readFileSync(new URL('../../data/rate-cards.json',import.meta.url),'utf8')).models;
const db = new DatabaseSync(join(h,'Library/Application Support/com.conductor.app/conductor.db'),{readOnly:true});
const registered = new Map<string,string>();
for (const r of db.prepare("SELECT id, claude_session_id FROM sessions WHERE agent_type = 'codex'").all() as any[]) if (r.claude_session_id) registered.set(r.claude_session_id,hash(r.id));
db.close();
const files: string[] = []; const roots = new Set<string>();
function walk(p: string) { for(const d of readdirSync(p,{withFileTypes:true})) { const q=join(p,d.name); if(d.isDirectory())walk(q);else if(d.name.endsWith('.jsonl'))files.push(q); } }
for(const p of readdirSync(h,{withFileTypes:true}).filter(d=>d.name==='.codex'||d.name.startsWith('.codex-')).map(d=>join(h,d.name)).concat(process.env.CODEX_HOME ? [process.env.CODEX_HOME] : []))for(const sub of ['sessions','archived_sessions']) {const q=join(p,sub);if(existsSync(q)){const r=realpathSync(q);if(!roots.has(r)){roots.add(r);walk(r);}}}
files.sort();
const observations: any[]=[]; const fileMetadata: any[]=[]; const requestRecords: any[]=[];
const nativeDb=new DatabaseSync(join(h,'.codex/state_5.sqlite'),{readOnly:true});
const nativeThreads=new Map((nativeDb.prepare('SELECT id,created_at,created_at_ms FROM threads').all() as any[]).map(r=>[registered.get(r.id)??hash(`codex:${r.id}`),new Date(r.created_at_ms??r.created_at*1000).toISOString()]));nativeDb.close();
const sessions = new Map<string,Session>(); const winners = new Map<string,Observation>();
const counters = {files:files.length,malformed:0,missingIdentityFiles:0,tokenObservations:0,uniqueStates:0,duplicates:0,openingBaselines:0,resetBaselines:0,undatedPositive:0,newRequestRecords:0,unsupportedModels: {} as Record<string,number>};
function earlier(a: Observation, b: Observation) { if(a.score!==b.score)return a.score<b.score; if(a.time!==b.time)return (a.time??'~')<(b.time??'~'); return a.file<b.file; }
for(const [fileIndex,file] of files.entries()) {
 let key: string | null=null, model='<unknown>', precedingResponse: string | null=null, previous: Usage | null=null;
 let broadActivity:string|null=null, broadType:string|null=null;const fileModels=new Set<string>();const fileTimes={absolute:0,missing:0,invalid:0,noOffset:0};
 const lines=readFileSync(file,'utf8').split('\n');
 for(const line of lines) {if(!line.trim())continue;let r:any;try{r=JSON.parse(line)}catch{counters.malformed++;continue} const p=r.payload??{};const time=absolute(r.timestamp);
  if(time)fileTimes.absolute++;else if(r.timestamp==null)fileTimes.missing++;else if(typeof r.timestamp==='string'&&Number.isFinite(Date.parse(r.timestamp)))fileTimes.noOffset++;else fileTimes.invalid++;
  const tokenEvent=r.type==='event_msg'&&p.type==='token_count';
  if(!tokenEvent&&r.type!=='session_meta'&&r.type!=='turn_context'&&time){broadActivity=time;broadType=r.type+':'+(p.type??'')+(p.type==='message'?':'+p.role:'');}
  if(r.type==='session_meta' && !key && typeof p.id==='string'){key=registered.get(p.id)??hash(`codex:${p.id}`);if(!sessions.has(key))sessions.set(key,{sessionKey:key,firstEventAt:null,lastEventAt:null,firstPositiveUsageAt:null,localTokenObservations:0,requestRecordCount:0,models:{},utc:{},london:{},undated:amount(),total:amount(),postReference:false});}
  if(!key)continue;const s=sessions.get(key)!;
  if(time){s.firstEventAt=s.firstEventAt===null||time<s.firstEventAt?time:s.firstEventAt;s.lastEventAt=s.lastEventAt===null||time>s.lastEventAt?time:s.lastEventAt; if(time>referenceTime)s.postReference=true;}
  if(r.type==='turn_context' && typeof p.model==='string')model=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(p.model)?p.model:'<unknown>';
  if(r.type==='turn_context'&&model!=='<unknown>')fileModels.add(model);
  if(r.type==='token_usage_record'){s.requestRecordCount++;counters.newRequestRecords++;requestRecords.push({sessionKey:key,fileIndex,time,usage:usage(p.usage),responseKey:typeof p.response_id==='string'?hash(p.response_id):null});}
  // Local model-response evidence precedes the usage observation; user/tool-result records are excluded.
  if((r.type==='response_item' && ['reasoning','function_call','custom_tool_call','web_search_call','tool_search_call','agent_message'].includes(p.type)) || (r.type==='response_item'&&p.type==='message'&&p.role==='assistant') || (r.type==='event_msg'&&['agent_message','agent_reasoning'].includes(p.type)) || (r.type==='event_msg'&&p.type==='item_completed'&&['AgentMessage','Reasoning','CommandExecution','McpToolCall','FileChange','WebSearch'].includes(p.item?.type))) {if(time)precedingResponse=time;}
  if(r.type!=='event_msg'||p.type!=='token_count'||!p.info?.total_token_usage)continue;
  counters.tokenObservations++;s.localTokenObservations++;
  const total=usage(p.info.total_token_usage), last=usage(p.info.last_token_usage);
  observations.push({sessionKey:key,fileIndex,time,total,last,hasLast:!!p.info.last_token_usage,model,strictScore:time&&precedingResponse&&precedingResponse<=time?Date.parse(time)-Date.parse(precedingResponse):null,broadScore:time&&broadActivity&&broadActivity<=time?Date.parse(time)-Date.parse(broadActivity):null,broadType});
  let bill=last;
  if(!positive(last)) {
   if(previous===null){counters.openingBaselines++;previous=total;continue;}
   if((Object.keys(total) as (keyof Usage)[]).some(k=>total[k]<previous![k])){counters.resetBaselines++;previous=total;continue;}
   bill={inputTokens:total.inputTokens-previous.inputTokens,cachedInputTokens:total.cachedInputTokens-previous.cachedInputTokens,outputTokens:total.outputTokens-previous.outputTokens,reasoningOutputTokens:total.reasoningOutputTokens-previous.reasoningOutputTokens};
  }
  previous=total;
  if(!positive(bill))continue;
  if(time)s.firstPositiveUsageAt=s.firstPositiveUsageAt===null||time<s.firstPositiveUsageAt?time:s.firstPositiveUsageAt;else counters.undatedPositive++;
  const state=JSON.stringify([total,last]);const score=time&&precedingResponse&&precedingResponse<=time?Date.parse(time)-Date.parse(precedingResponse):Infinity;
  const obs:Observation={file,key,time,usage:bill,model,score,state};const old=winners.get(state);if(!old||earlier(obs,old))winners.set(state,obs);if(old)counters.duplicates++;
 }
 if(!key)counters.missingIdentityFiles++;fileMetadata.push({sessionKey:key,fileIndex,models:[...fileModels],timestamps:fileTimes,nativeCreatedAt:key?nativeThreads.get(key)??null:null});
}
const london = new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'});
for(const o of winners.values()) {
 const s=sessions.get(o.key)!; const r=rates[o.model]; let usd=0;
 if(r){const long=r.longContext&&o.usage.inputTokens>r.longContext.thresholdInputTokens;const im=long?r.longContext.inputMultiplier:1,om=long?r.longContext.outputMultiplier:1;usd=((o.usage.inputTokens-o.usage.cachedInputTokens)*r.inputPerMillion*im+o.usage.cachedInputTokens*r.cachedInputPerMillion*im+o.usage.outputTokens*r.outputPerMillion*om)/1e6;}
 else counters.unsupportedModels[o.model]=(counters.unsupportedModels[o.model]??0)+1;
 const a:Amount={...o.usage,valueUsd:usd,calls:1};add(s.total,a);add(s.models[o.model]??=amount(),a);
 if(o.time){add(s.utc[o.time.slice(0,10)]??=amount(),a);add(s.london[london.format(new Date(o.time))]??=amount(),a);}else add(s.undated,a);
}
counters.uniqueStates=winners.size;
writeFileSync('.lane/codex-observations.json',JSON.stringify({referenceTime,observations,fileMetadata,requestRecords})+'\n');
const output={oracleVersion:1,referenceTime,timeZones:['UTC','Europe/London'],counters,sessions:[...sessions.values()].sort((a,b)=>a.sessionKey.localeCompare(b.sessionKey))};
mkdirSync('.lane',{recursive:true});writeFileSync('.lane/codex-oracle.json',JSON.stringify(output,null,2)+'\n');
// First comparison occurs only after the independent oracle has been written.
const reference=JSON.parse(readFileSync(snapshotFile,'utf8'));const ref=new Map(reference.sessions.filter((s:any)=>s.provider==='codex').map((s:any)=>[s.sessionKey,s]));
const differences:any[]=[];const matched:Session[]=[];
for(const s of output.sessions){if(s.postReference)continue;const r:any=ref.get(s.sessionKey);if(!r)continue;matched.push(s);const days=[...new Set([...Object.keys(s.utc),...Object.keys(r.spendByDay)])].sort();const daily=days.map(day=>({day,oracle:s.utc[day]?.valueUsd??0,reference:r.spendByDay[day]??0})).filter(d=>Math.abs(d.oracle-d.reference)>0.000001);const input=s.total.inputTokens-r.tokens.inputTokens,output=s.total.outputTokens-r.tokens.outputTokens;if(daily.length||input||output||s.firstEventAt!==r.firstEventAt||s.lastEventAt!==r.lastEventAt)differences.push({sessionKey:s.sessionKey,inputDifference:input,outputDifference:output,valueDifference:s.total.valueUsd-r.cost.totalUsd,firstEventAtEqual:s.firstEventAt===r.firstEventAt,lastEventAtEqual:s.lastEventAt===r.lastEventAt,daily});}
const report={counters,referenceSessions:ref.size,oracleSessions:output.sessions.length,matchedStable:matched.length,postReference:output.sessions.filter(s=>s.postReference).length,unmatchedStable:output.sessions.filter(s=>!s.postReference&&!ref.has(s.sessionKey)).map(s=>s.sessionKey),differenceSessions:differences.length,differences};
writeFileSync('.lane/codex-post-audit-diff.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,differences:undefined,unmatchedStable:report.unmatchedStable.length}));
