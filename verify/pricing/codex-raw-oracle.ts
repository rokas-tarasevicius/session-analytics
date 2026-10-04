/** Independent raw Codex request accounting oracle. No imports from src/.
 * All provider identities and source paths remain in memory. Emitted evidence is
 * limited to hashes, model IDs, enums, timestamps and numeric counters.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createInterface } from 'node:readline';
import { DatabaseSync } from '../shared/sqlite.ts';

const snapshot = JSON.parse(fs.readFileSync(process.argv[2] ?? '../reference/snapshot-noindex-51ea561.json', 'utf8'));
const cutoff = Date.parse(snapshot.generatedAt);
const reviewed = JSON.parse(fs.readFileSync('data/rate-cards.json', 'utf8')).models;
const sourceActivity = process.argv.includes('--source-activity');
const outPath = process.argv[3] ?? '.lane/codex-raw-oracle.json';
const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
const number = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;
// Independent bounded model-family grammar: never export arbitrary strings from
// metadata/database fields as model IDs, even when they are short.
const validModel = (value: unknown): value is string => typeof value === 'string' && value.length <= 128 &&
 /^(?:openai\/)?(?:gpt-\d+(?:[.-]\d+)*[a-z]?(?:-(?:codex|spark|sol|terra|astra|mini|nano|pro|preview|turbo|max|latest|\d{4}-\d{2}-\d{2}|\d{8}))*|chatgpt-\d+(?:[.-]\d+)*-latest|o[1-9](?:-mini|-pro)?(?:-\d{4}-\d{2}-\d{2})?)$/i.test(value);
type Usage = [number, number, number, number, number];
type Claim = { file: number; model: string; tier: string; time: number; gap: number; usage: Usage; fallback: boolean };
type File = { valid?: boolean; models: Set<string>; path: string; key: string; last: number; states: number; direct: number; malformed: number; meta: number; fallbackBaselines: number; tiers: Set<string> };
const fields = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
function usage(u: any): Usage { return fields.map(k => number(u?.[k])) as Usage; }
function* walk(dir: string): Generator<string> { let entries; try { entries = fs.readdirSync(dir, {withFileTypes:true}); } catch { return; } for(const e of entries){const p=path.join(dir,e.name);if(e.isDirectory())yield* walk(p);else if(e.isFile()&&e.name.endsWith('.jsonl'))yield p;}}
const rawToConductor = new Map<string,string>();
const databaseModels = new Map<string,string>();
try { const db = new DatabaseSync(path.join(os.homedir(), 'Library/Application Support/com.conductor.app/conductor.db'), {readOnly:true});
 for(const r of db.prepare("SELECT id,claude_session_id,model FROM sessions WHERE agent_type='codex' ORDER BY datetime(created_at) ASC").all() as any[]) if(r.claude_session_id) {rawToConductor.set(r.claude_session_id,hash(r.id));if(validModel(r.model))databaseModels.set(r.claude_session_id,r.model);} db.close();
} catch { /* no optional enrichment */ }
const roots = new Set<string>();
for(const e of fs.readdirSync(os.homedir(),{withFileTypes:true})) if((e.isDirectory()||e.isSymbolicLink())&&/^\.codex(?:-|$)/.test(e.name))for(const child of ['sessions','archived_sessions'])try{roots.add(fs.realpathSync(path.join(os.homedir(),e.name,child)));}catch{}
if(process.env.CODEX_HOME) for(const child of ['sessions','archived_sessions'])try{roots.add(fs.realpathSync(path.join(process.env.CODEX_HOME,child)));}catch{}
const paths = [...new Set([...roots].flatMap(r=>[...walk(r)]))].sort();
const files:File[]=[]; const claims=new Map<string,Claim>(); const directShapes:Record<string,number>={};
let observations=0, afterCutoff=0, invalidInputs=0, invalidReasoning=0, absentModel=0;
function wins(c:Claim, old:Claim){return c.gap<old.gap || (c.gap===old.gap&&(c.time<old.time||(c.time===old.time&&files[c.file].path<files[old.file].path)));}
for(const p of paths){
 const f:File={models:new Set(),path:p,key:'',last:0,states:0,direct:0,malformed:0,meta:0,fallbackBaselines:0,tiers:new Set()}; const fi=files.push(f)-1;
 let model='unknown',tier='unknown',previous:Usage|undefined,lastResponse=-Infinity;
 try{for await(const line of createInterface({input:fs.createReadStream(p),crlfDelay:Infinity})){
  let r:any;try{r=JSON.parse(line)}catch{f.malformed++;continue;} if(!r||typeof r!=='object')continue;
  const t=Date.parse(r.timestamp), q=r.payload??{};
  if(Number.isFinite(t))f.last=Math.max(f.last,t);
  if(r.type==='session_meta'){f.meta++;if(f.meta===1)f.valid=typeof q.id==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(q.id)&&path.basename(p).endsWith(q.id+'.jsonl')&&typeof q.cwd==='string'&&q.cwd.length>0;if(!f.key&&typeof q.id==='string'){f.key=rawToConductor.get(q.id)??hash('codex:'+q.id);if(sourceActivity&&databaseModels.has(q.id))model=databaseModels.get(q.id)!;}}
  if(f.valid!==true)continue;
  if(r.type==='turn_context'){if(Object.hasOwn(q,'model')&&!validModel(q.model))model='unknown';if(validModel(q.model)){model=q.model;f.models.add(model);}if(typeof q.service_tier==='string'&&['default','standard','priority','flex','auto','fast'].includes(q.service_tier))tier=q.service_tier;}
  if(q.type==='token_usage_record'){f.direct++; const k=Object.keys(q).slice(0,64).map(k=>/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(k)?k:'unrecognized_field').sort().join(',');directShapes[k]=(directShapes[k]??0)+1;}
  if((r.type==='response_item'&&(['reasoning','function_call','custom_tool_call'].includes(q.type)||(q.type==='message'&&q.role==='assistant')))||(r.type==='event_msg'&&['agent_message','agent_reasoning'].includes(q.type))) {if(Number.isFinite(t))lastResponse=t;}
  if(sourceActivity&&r.type!=='session_meta'&&r.type!=='turn_context'&&!(r.type==='event_msg'&&q.type==='token_count')&&Number.isFinite(t))lastResponse=t;
  if(r.type!=='event_msg'||q.type!=='token_count'||!q.info?.total_token_usage)continue;
  observations++;f.states++;
  const total=usage(q.info.total_token_usage), supplied=q.info.last_token_usage;
  let u:Usage, fallback=false;
  if(supplied&&typeof supplied==='object'&&(number(supplied.input_tokens)+number(supplied.output_tokens)>0)){u=usage(supplied);}else {fallback=true;if(!previous||total.some((v,i)=>v<previous![i])){previous=total;f.fallbackBaselines++;continue;}u=total.map((v,i)=>v-previous![i]) as Usage;}
  previous=total;
  if(t>cutoff){afterCutoff++;continue;}
  if(u[1]>u[0])invalidInputs++;if(u[3]>u[2])invalidReasoning++;
  if(!u[0]&&!u[2])continue;
  if(model==='unknown')absentModel++;
  const state=(fallback?'fallback:'+fi+':':'')+total.slice(0,4).join(',')+'|'+(supplied?usage(supplied).slice(0,4).join(','):'no-last');
  const c:Claim={file:fi,model,tier,time:Number.isFinite(t)?t:Infinity,gap:Number.isFinite(t)&&lastResponse<=t?t-lastResponse:Infinity,usage:u,fallback};
  const old=claims.get(state);if(!old||wins(c,old))claims.set(state,c);f.tiers.add(tier);
 }}catch{f.malformed++;}
 if((fi+1)%500===0)console.error(JSON.stringify({filesRead:fi+1,totalFiles:paths.length,uniqueStates:claims.size}));
}
for(const c of claims.values()) if(c.model==='unknown'&&files[c.file].models.size===1)c.model=[...files[c.file].models][0];
const projection=fs.openSync(sourceActivity?'.lane/codex-source-owned-requests.jsonl':'.lane/codex-owned-requests.jsonl','w');
for(const c of claims.values()){const f=files[c.file];fs.writeSync(projection,JSON.stringify({sessionKey:f.key,model:c.model,tier:c.tier,time:Number.isFinite(c.time)?new Date(c.time).toISOString():null,usage:c.usage,liveAfterReference:f.last>cutoff,requestSizeKnown:!c.fallback})+'\n');}fs.closeSync(projection);
const bySession=new Map<string,any>();
const empty=()=>({inputTokens:0,cachedInputTokens:0,uncachedInputTokens:0,outputTokens:0,reasoningOutputTokens:0,calls:0,totalUsd:0,upperEstimateUsd:0,pricedCalls:0,longCalls:0,longInputTokens:0,longCachedInputTokens:0,longOutputTokens:0,longPremiumUsd:0,above200kCalls:0,fallbackCalls:0,unknownModelCalls:0});
const add=(a:any,b:any)=>{for(const k of Object.keys(empty()))a[k]+=(b[k]??0);};
for(const c of claims.values()){
 const f=files[c.file];if(!f.key)continue;
 let session=bySession.get(f.key);if(!session){session={sessionKey:f.key,lastEventAt:new Date(f.last).toISOString(),liveAfterReference:f.last>cutoff,...empty(),models:{},months:{},tiers:{}};bySession.set(f.key,session);}
 const [input,cached,output,reasoning]=c.usage;
 const rate=reviewed[c.model],long=!c.fallback&&rate?.longContext&&input>rate.longContext.thresholdInputTokens;
 const im=long?rate.longContext.inputMultiplier:1,om=long?rate.longContext.outputMultiplier:1;
 const usd=rate?((input-cached)*rate.inputPerMillion*im+cached*rate.cachedInputPerMillion*im+output*rate.outputPerMillion*om)/1e6:0;
 const upper=rate?usd+(input-cached)*rate.inputPerMillion*im*((rate.cacheWriteMultiplier??1)-1)/1e6:0;
 const standard=rate?((input-cached)*rate.inputPerMillion+cached*rate.cachedInputPerMillion+output*rate.outputPerMillion)/1e6:0;
 const v={inputTokens:input,cachedInputTokens:cached,uncachedInputTokens:input-cached,outputTokens:output,reasoningOutputTokens:reasoning,calls:1,totalUsd:usd,upperEstimateUsd:upper,pricedCalls:rate?1:0,longCalls:long?1:0,longInputTokens:long?input:0,longCachedInputTokens:long?cached:0,longOutputTokens:long?output:0,longPremiumUsd:usd-standard,above200kCalls:input>200000?1:0,fallbackCalls:c.fallback?1:0,unknownModelCalls:c.model==='unknown'?1:0};
 add(session,v);add(session.models[c.model]??=empty(),v);add(session.months[Number.isFinite(c.time)?new Date(c.time).toISOString().slice(0,7):'undated']??=empty(),v);add(session.tiers[c.tier]??=empty(),v);
}
const ref=new Map(snapshot.sessions.filter((s:any)=>s.provider==='codex').map((s:any)=>[s.sessionKey,s]));
const totals=empty(),byModel:Record<string,any>={},byMonth:Record<string,any>={},diffs:any[]=[];let matched=0,liveExcluded=0,noReference=0,exactTokens=0;
for(const s of bySession.values()){
 if(s.liveAfterReference){liveExcluded++;continue;}const r:any=ref.get(s.sessionKey);if(!r){noReference++;continue;}matched++;add(totals,s);
 for(const [m,v]of Object.entries(s.models))add(byModel[m]??=empty(),v);
 for(const [m,v]of Object.entries(s.months))add(byMonth[m]??=empty(),v);
 const d:any={sessionKey:s.sessionKey};let bad=false;
 for(const k of ['inputTokens','cachedInputTokens','uncachedInputTokens','outputTokens','reasoningOutputTokens'])if(s[k]!==r.tokens[k]){d[k]={oracle:s[k],reference:r.tokens[k],delta:s[k]-r.tokens[k]};bad=true;}
 if(!bad)exactTokens++;
 if(s.pricedCalls===s.calls){for(const k of ['totalUsd','upperEstimateUsd'])if(Math.abs(s[k]-r.cost[k])>1e-7){d[k]={oracle:s[k],reference:r.cost[k],delta:s[k]-r.cost[k]};bad=true;}}
 if(bad)diffs.push(d);
}
const fileKeys=[...new Set(files.map(f=>f.key).filter(Boolean))];
const missingReferenceSessions=[...ref.values()].filter((r:any)=>!bySession.has(r.sessionKey)).map((r:any)=>({sessionKey:r.sessionKey,rawFileExists:fileKeys.includes(r.sessionKey),inputTokens:r.tokens.inputTokens,outputTokens:r.tokens.outputTokens,totalUsd:r.cost.totalUsd}));
const result={sourceActivity,missingReferenceSessions,fileSessionKeys:fileKeys,generatedAt:new Date().toISOString(),referenceGeneratedAt:snapshot.generatedAt,method:sourceActivity?'Source-aligned explanatory ownership replay; reviewed rates only, no implementation imports':'Independent documented total/last state ownership; reviewed rates only, no implementation imports',counts:{files:files.length,validFiles:files.filter(f=>f.valid).length,invalidIdentityFiles:files.filter(f=>f.valid===false).length,roots:roots.size,observations,uniqueStates:claims.size,afterCutoff,invalidInputs,invalidReasoning,absentModel,filesWithUsageRecords:files.filter(f=>f.direct).length,directUsageRecords:files.reduce((n,f)=>n+f.direct,0),malformedRecords:files.reduce((n,f)=>n+f.malformed,0),matched,liveExcluded,noReference,exactTokens,differences:diffs.length},directShapes,totals,byModel,byMonth,differences:diffs,sessions:[...bySession.values()]};
fs.writeFileSync(outPath,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({counts:result.counts,totals,byModel,directShapes},null,2));
