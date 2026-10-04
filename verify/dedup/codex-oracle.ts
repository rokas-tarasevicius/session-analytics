/** Independent raw Codex identity oracle. Written before reading analyzer source.
 * No src imports. Never emits raw IDs, content, paths, errors, or repository names.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { DatabaseSync } from '../shared/sqlite.ts';
const hash=(x)=>crypto.createHash('sha256').update(String(x)).digest('hex').slice(0,12);
const home=os.homedir();
const reference=JSON.parse(fs.readFileSync(new URL('../../../reference/snapshot-noindex-51ea561.json',import.meta.url),'utf8'));
const cutoff=Date.parse(reference.generatedAt);
const rates=JSON.parse(fs.readFileSync(new URL('../../data/rate-cards.json',import.meta.url),'utf8')).models;
const safeModel=(v)=>typeof v==='string'&&/^(?:gpt-[a-z0-9][a-z0-9._:-]{0,100}|o[1-9][a-z0-9._:-]*|codex|chatgpt-[a-z0-9._:-]+)$/i.test(v)?v:'unknown';
const safeTypes=new Set(['session_meta','response_item','event_msg','turn_context','compacted','world_state','inter_agent_communication_metadata','token_usage_record']);
const observedTypes={}, count=(o,k)=>o[k]=(o[k]||0)+1;
const fields=['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'];
const vector=(v)=>fields.map(k=>Number.isFinite(v?.[k])?Math.max(0,v[k]):0);
const positive=(v)=>v.some(x=>x>0);
const plus=(a,b)=>a.map((x,i)=>x+b[i]);
const zero=()=>fields.map(()=>0);
const priced=(v,model)=>{const r=rates[model];if(!r)return 0;const long=r.longContext&&v[0]>r.longContext.thresholdInputTokens;return ((v[0]-Math.min(v[0],v[1]))*r.inputPerMillion*(long?r.longContext.inputMultiplier:1)+Math.min(v[0],v[1])*r.cachedInputPerMillion*(long?r.longContext.inputMultiplier:1)+v[2]*r.outputPerMillion*(long?r.longContext.outputMultiplier:1))/1e6;};
const rows=[];let db;try{db=new DatabaseSync(path.join(home,'Library/Application Support/com.conductor.app/conductor.db'),{readOnly:true});rows.push(...db.prepare("SELECT id,claude_session_id,agent_type,created_at,model FROM sessions WHERE agent_type='codex'").all());db.close();}catch{}
const registered=new Map();for(const row of rows){if(row.claude_session_id){const list=registered.get(row.claude_session_id)||[];list.push(row);registered.set(row.claude_session_id,list);}}
const sessionKey=(id)=>registered.has(id)?hash(registered.get(id)[0].id):hash(`codex:${id}`);
const roots=new Set();for(const name of fs.readdirSync(home)){if(name==='.codex'||name.startsWith('.codex-')){for(const dir of ['sessions','archived_sessions']){try{roots.add(fs.realpathSync(path.join(home,name,dir)));}catch{}}}}
if(process.env.CODEX_HOME)for(const dir of ['sessions','archived_sessions']){try{roots.add(fs.realpathSync(path.join(process.env.CODEX_HOME,dir)));}catch{}}
const paths=[];const visited=new Set();function walk(dir){let real;try{real=fs.realpathSync(dir);}catch{return;}if(visited.has(real))return;visited.add(real);let entries;try{entries=fs.readdirSync(real,{withFileTypes:true});}catch{return;}for(const entry of entries){const p=path.join(real,entry.name);if(entry.isDirectory())walk(p);else if(entry.isFile()&&entry.name.endsWith('.jsonl'))paths.push(p);}}
for(const root of roots)walk(root);paths.sort();
const files=[],states=new Map();let lineCount=0, malformed=0, tokenUsageRecordCount=0;
for(const filepath of paths){const f={filepath,source:path.basename(path.dirname(filepath))==='archived_sessions'?'archived':'active',ids:[],forks:[],parentIds:[],first:null,last:null,models:new Set(),observations:[],responses:0,metadata:0,digest:null,lines:0};let currentId=null,currentModel=null,currentMetaTime=null,lastResponseTime=null,lastTotal=null;const digest=crypto.createHash('sha256');
 try{for await(const line of readline.createInterface({input:fs.createReadStream(filepath),crlfDelay:Infinity})){lineCount++;f.lines++;digest.update(line);digest.update('\n');let r;try{r=JSON.parse(line);}catch{malformed++;continue;}if(!r||typeof r!=='object')continue;count(observedTypes,safeTypes.has(r.type)?r.type:'unsupported_record');const p=r.payload||{};const ts=Date.parse(r.timestamp||p.timestamp);if(Number.isFinite(ts)){f.first=f.first===null?ts:Math.min(f.first,ts);f.last=f.last===null?ts:Math.max(f.last,ts);}
 if(r.type==='session_meta'){f.metadata++;if(typeof p.id==='string'){currentId=p.id;if(!f.ids.includes(p.id))f.ids.push(p.id);}currentMetaTime=Date.parse(p.timestamp||r.timestamp);if(typeof p.forked_from_id==='string'&&!f.forks.includes(p.forked_from_id))f.forks.push(p.forked_from_id);const parent=p.source?.subagent?.thread_spawn?.parent_thread_id;if(typeof parent==='string'&&!f.parentIds.includes(parent))f.parentIds.push(parent);}
 if(r.type==='turn_context'&&typeof p.model==='string'){currentModel=safeModel(p.model);f.models.add(currentModel);}
 if((r.type==='response_item'&&['function_call','custom_tool_call'].includes(p.type))||(r.type==='response_item'&&p.type==='message'&&p.role==='assistant')||(r.type==='event_msg'&&['agent_message','agent_reasoning'].includes(p.type))||(r.type==='event_msg'&&p.type==='item_completed'&&['AgentMessage','CommandExecution','FileChange','McpToolCall','WebSearch'].includes(p.item?.type))){if(Number.isFinite(ts))lastResponseTime=ts;f.responses++;}
 if(r.type==='event_msg'&&p.type==='token_usage_record')tokenUsageRecordCount++;
 if(r.type!=='event_msg'||p.type!=='token_count'||!p.info?.total_token_usage)continue;
 const total=vector(p.info.total_token_usage),last=vector(p.info.last_token_usage);let contribution=last;let mode='last';if(!positive(last)){mode='baseline';contribution=zero();if(lastTotal&&total.every((x,i)=>x>=lastTotal[i])){contribution=total.map((x,i)=>x-lastTotal[i]);mode='delta';}}
 lastTotal=total;
 const state=JSON.stringify([total,last]);const observation={file:files.length,index:f.observations.length,line:f.lines,state,ts:Number.isFinite(ts)?ts:null,id:currentId,model:currentModel,total,last,contribution,mode,responseGap:Number.isFinite(ts)&&lastResponseTime!==null&&ts>=lastResponseTime?ts-lastResponseTime:null,metaTime:Number.isFinite(currentMetaTime)?currentMetaTime:null};
 f.observations.push(observation);const list=states.get(state)||[];list.push(observation);states.set(state,list);
 }}catch{count(observedTypes,'read_failure');}
 f.digest=digest.digest('hex');files.push(f);
}
const ref=new Map(reference.sessions.filter(s=>s.provider==='codex').map(s=>[s.sessionKey,s]));
const liveIds=new Set(files.filter(f=>f.last!==null&&f.last>cutoff).flatMap(f=>f.ids));
const duplicateIds=new Map(),duplicateFiles=new Map();for(const f of files){const id=f.ids.at(-1);if(id){const list=duplicateIds.get(id)||[];list.push(f);duplicateIds.set(id,list);}const same=duplicateFiles.get(f.digest)||[];same.push(f);duplicateFiles.set(f.digest,same);}
const oracle=new Map();function get(id){const key=sessionKey(id);let a=oracle.get(key);if(!a){a={sessionKey:key,provider:'codex',inputTokens:0,cachedInputTokens:0,outputTokens:0,reasoningOutputTokens:0,totalUsd:0,calls:0,months:{},models:{},live:liveIds.has(id)};oracle.set(key,a);}return a;}
for(const f of files){if(f.ids.at(-1))get(f.ids.at(-1));}
let crossIdentityStates=0,crossDayStates=0,crossModelStates=0,crossParentStates=0,baselineStates=0,preMetaStates=0,liveStates=0;const collisionSamples=[];
for(const [state,observations] of states){const candidates=observations.filter(o=>o.id&&o.ts!==null&&o.ts<=cutoff);if(!candidates.length)continue;const ids=new Set(candidates.map(o=>o.id));const days=new Set(candidates.map(o=>new Date(o.ts).toISOString().slice(0,10)));const models=new Set(candidates.map(o=>o.model).filter(Boolean));if(ids.size>1)crossIdentityStates++;if(days.size>1)crossDayStates++;if(models.size>1)crossModelStates++;
 // Native response adjacency, then earliest occurrence; tie-break stable raw path only internally.
 candidates.sort((a,b)=>(a.responseGap??Infinity)-(b.responseGap??Infinity)||a.ts-b.ts||files[a.file].filepath.localeCompare(files[b.file].filepath)||a.line-b.line);
 const owner=candidates[0];if(owner.mode==='baseline')baselineStates++;if(owner.metaTime!==null&&owner.ts<owner.metaTime)preMetaStates++;
 if(liveIds.has(owner.id)){liveStates++;continue;}const a=get(owner.id),v=owner.contribution;const model=owner.model||safeModel(registered.get(owner.id)?.[0]?.model);const dollars=priced(v,model);a.inputTokens+=v[0];a.cachedInputTokens+=v[1];a.outputTokens+=v[2];a.reasoningOutputTokens+=v[3];a.totalUsd+=dollars;if(positive(v))a.calls++;
 const month=new Date(owner.ts).toISOString().slice(0,7);for(const [bag,k] of [[a.months,month],[a.models,model]]){const cell=bag[k]||(bag[k]={inputTokens:0,cachedInputTokens:0,outputTokens:0,totalUsd:0,calls:0});cell.inputTokens+=v[0];cell.cachedInputTokens+=v[1];cell.outputTokens+=v[2];cell.totalUsd+=dollars;if(positive(v))cell.calls++;}
 if(ids.size>1&&days.size>1&&collisionSamples.length<100)collisionSamples.push({stateKey:hash(state),identities:ids.size,days:days.size,models:[...models],timestamps:[Math.min(...candidates.map(o=>o.ts)),Math.max(...candidates.map(o=>o.ts))].map(t=>new Date(t).toISOString()),last:owner.last,owner:sessionKey(owner.id)});
}
const diffs=[],missing=[],extra=[];for(const [key,a] of oracle){if(a.live)continue;const s=ref.get(key);if(!s){missing.push({sessionKey:key,inputTokens:a.inputTokens,outputTokens:a.outputTokens,totalUsd:a.totalUsd,calls:a.calls});continue;}const delta={inputTokens:a.inputTokens-s.tokens.inputTokens,cachedInputTokens:a.cachedInputTokens-s.tokens.cachedInputTokens,outputTokens:a.outputTokens-s.tokens.outputTokens,reasoningOutputTokens:a.reasoningOutputTokens-s.tokens.reasoningOutputTokens,totalUsd:a.totalUsd-s.cost.totalUsd,calls:a.calls-s.metrics.modelCalls};if(Object.values(delta).some(v=>Math.abs(v)>1e-7))diffs.push({sessionKey:key,oracle:{inputTokens:a.inputTokens,outputTokens:a.outputTokens,totalUsd:a.totalUsd,calls:a.calls},reference:{inputTokens:s.tokens.inputTokens,outputTokens:s.tokens.outputTokens,totalUsd:s.cost.totalUsd,calls:s.metrics.modelCalls},delta});}
for(const [key,s]of ref)if(!oracle.has(key))extra.push({sessionKey:key,inputTokens:s.tokens.inputTokens,outputTokens:s.tokens.outputTokens,totalUsd:s.cost.totalUsd});
const summarize=(list)=>list.reduce((a,s)=>{a.sessions++;for(const k of ['inputTokens','cachedInputTokens','outputTokens','reasoningOutputTokens','totalUsd','calls'])a[k]=(a[k]||0)+(s[k]||0);return a;},{sessions:0});
const report={version:1,referenceGeneratedAt:reference.generatedAt,inventory:{roots:roots.size,files:files.length,lines:lineCount,malformed,tokenUsageRecordCount,observedTypes,conductorRows:rows.length,conductorDuplicateProviderIds:[...registered.values()].filter(x=>x.length>1).length,identities:duplicateIds.size,liveIdentities:liveIds.size,duplicateIdentityGroups:[...duplicateIds.values()].filter(x=>x.length>1).map(group=>({sessionKey:sessionKey(group[0].ids.at(-1)),files:group.length,digests:new Set(group.map(f=>f.digest)).size,observations:group.map(f=>f.observations.length)})),exactDuplicateGroups:[...duplicateFiles.values()].filter(x=>x.length>1).map(g=>({files:g.length,identities:new Set(g.flatMap(f=>f.ids)).size})),forkFiles:files.filter(f=>f.forks.length).length,multiIdentityFiles:files.filter(f=>f.ids.length>1).length,filesWithoutIdentity:files.filter(f=>!f.ids.length).length},states:{unique:states.size,observations:files.reduce((n,f)=>n+f.observations.length,0),crossIdentityStates,crossDayStates,crossModelStates,baselineStates,preMetaStates,liveStates,collisionSamples},totals:summarize([...oracle.values()].filter(s=>!s.live)),referenceCompared:summarize([...oracle.values()].filter(s=>!s.live&&ref.has(s.sessionKey)).map(a=>{const s=ref.get(a.sessionKey);return {...s.tokens,totalUsd:s.cost.totalUsd,calls:s.metrics.modelCalls};})),missing,extra,diffs:diffs.sort((a,b)=>Math.abs(b.delta.totalUsd)-Math.abs(a.delta.totalUsd)),sessions:[...oracle.values()].filter(s=>!s.live)};
fs.writeFileSync('.lane/codex-oracle-initial.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({inventory:report.inventory,states:{...report.states,collisionSamples:undefined},totals:report.totals,referenceCompared:report.referenceCompared,diffSessions:diffs.length,missing:missing.length,extra:extra.length}));
