// Independent native-transcript calibration of the Conductor marginal ledger.
// No application source imports; private paths/IDs/content remain in memory.
process.on('uncaughtException',()=>{console.error('Native calibration failed; private details suppressed.');process.exit(1);});
process.on('unhandledRejection',()=>{console.error('Native calibration failed; private details suppressed.');process.exit(1);});
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import readline from 'node:readline';import {DatabaseSync} from '../shared/sqlite.ts';
const hash=s=>crypto.createHash('sha256').update(String(s)).digest('hex').slice(0,12);
const sem=JSON.parse(fs.readFileSync('.lane/conductor-semantics.json','utf8'));
const ref=JSON.parse(fs.readFileSync('.lane/conductor-reference.json','utf8'));const refs=new Map(ref.sessions.map(s=>[s.sessionKey,s]));
const wanted=new Map(sem.sessions.filter(s=>!s.continuedAfterCutoff&&refs.get(s.sessionKey)?.source==='native'&&s.results.some(r=>r.marginalCostUsd!==undefined)).map(s=>[s.sessionKey,{...s,files:[],requests:new Map()}]));
const home=os.homedir(),db=new DatabaseSync(path.join(home,'Library/Application Support/com.conductor.app/conductor.db'),{readOnly:true});
const byId=new Map();for(const r of db.prepare("select id,claude_session_id from sessions where agent_type='claude'").iterate()){const s=wanted.get(hash(r.id));if(s)for(const id of [r.id,r.claude_session_id].filter(Boolean))byId.set(id,s);}db.close();
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(e.isFile()&&e.name.endsWith('.jsonl')){let s=byId.get(e.name.slice(0,-6)),child=false;const parts=dir.split(path.sep),i=parts.lastIndexOf('subagents');if(!s&&i>0){s=byId.get(parts[i-1]);child=!!s;}if(s)s.files.push({path:p,child});}}}
for(const e of fs.readdirSync(home,{withFileTypes:true}))if(e.isDirectory()&&/^\.claude(?:-|$)/.test(e.name)){const p=path.join(home,e.name,'projects');if(fs.existsSync(p))walk(p);}
const card=JSON.parse(fs.readFileSync('data/rate-cards.json','utf8')).models;
for(const m of ['claude-opus-4-5','claude-opus-4-5-20251101','claude-opus-4-6-20260205','claude-opus-4-7','claude-opus-4-7-20260416'])card[m]={...card['claude-opus-4-6']};card['claude-haiku-4-5']={...card['claude-haiku-4-5-20251001']};for(const m of ['claude-sonnet-4-5','claude-sonnet-4-5-20250929','claude-sonnet-4-6'])card[m]={inputPerMillion:3,cacheReadPerMillion:.3,cacheWrite5mPerMillion:3.75,cacheWrite1hPerMillion:6,outputPerMillion:15};
const n=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0?x:0;
const blank=()=>({input:0,read:0,write:0,write5m:0,write1h:0,output:0,search:0,fetch:0});
const usage=u=>({input:n(u?.input_tokens),read:n(u?.cache_read_input_tokens),write:n(u?.cache_creation_input_tokens),write5m:n(u?.cache_creation?.ephemeral_5m_input_tokens),write1h:n(u?.cache_creation?.ephemeral_1h_input_tokens),output:n(u?.output_tokens),search:n(u?.server_tool_use?.web_search_requests),fetch:n(u?.server_tool_use?.web_fetch_requests)});
const max=(a,b)=>{for(const k of Object.keys(a))a[k]=Math.max(a[k],b[k]);};
function price(m,u){const r=card[m.replace(/\[1m\]$/,'')];return r?(u.input*r.inputPerMillion+u.read*r.cacheReadPerMillion+Math.max(0,u.write-u.write1h)*r.cacheWrite5mPerMillion+u.write1h*r.cacheWrite1hPerMillion+u.output*r.outputPerMillion)/1e6:null;}
const output=[];let processed=0;
for(const s of wanted.values()){
 let malformed=0,missingIds=0;
 for(const f of s.files)for await(const line of readline.createInterface({input:fs.createReadStream(f.path),crlfDelay:Infinity})){
  let e;try{e=JSON.parse(line);}catch{malformed++;continue;}if(e.type!=='assistant'||!e.message?.usage)continue;const m=e.message;if(typeof m.id!=='string'){missingIds++;continue;}const at=Date.parse(e.timestamp);if(!Number.isFinite(at)||at>Date.parse(sem.cutoff))continue;
  const model=typeof m.model==='string'&&/^claude-[a-z0-9.-]+(?:\[1m\])?$/.test(m.model)?m.model:'unknown';
  const prev=s.requests.get(m.id);if(prev){max(prev.usage,usage(m.usage));prev.firstAt=Math.min(prev.firstAt,at);prev.lastAt=Math.max(prev.lastAt,at);prev.fast ||= m.usage.speed==='fast';if(typeof e.version==='string'&&/^\d+\.\d+\.\d+$/.test(e.version))prev.versions.add(e.version);}
  else s.requests.set(m.id,{model,usage:usage(m.usage),firstAt:at,lastAt:at,fast:m.usage.speed==='fast',child:f.child||!!e.parent_tool_use_id,versions:new Set(typeof e.version==='string'&&/^\d+\.\d+\.\d+$/.test(e.version)?[e.version]:[])});
 }
 const intervals=s.results.map((r,i)=>({sequence:i,createdAt:r.createdAt,model:r.model,cost:r.totalCostUsd,marginal:r.marginalCostUsd,previousCost:i?s.results[i-1].totalCostUsd:0,delta:i?r.totalCostUsd-s.results[i-1].totalCostUsd:r.totalCostUsd,nativeRequests:0,nativeUsd:0,nativeMainUsd:0,unknownRequests:0,fastRequests:0,hostedToolRequests:0,missingTtlWriteTokens:0,nativeTokens:blank(),versions:new Set()}));
 const after=blank();let trailingRequests=0;
 for(const r of s.requests.values()){
  const interval=intervals.find(x=>r.firstAt<=Date.parse(x.createdAt));if(!interval){trailingRequests++;continue;}interval.nativeRequests++;for(const version of r.versions)interval.versions.add(version);const usd=price(r.model,r.usage);if(usd===null)interval.unknownRequests++;else{interval.nativeUsd+=usd;if(!r.child)interval.nativeMainUsd+=usd;}
  interval.fastRequests+=Number(r.fast);interval.hostedToolRequests+=r.usage.search+r.usage.fetch;interval.missingTtlWriteTokens+=Math.max(0,r.usage.write-r.usage.write5m-r.usage.write1h);for(const k of Object.keys(interval.nativeTokens))interval.nativeTokens[k]+=r.usage[k];
 }
 for(const interval of intervals)interval.versions=[...interval.versions].sort();
 output.push({sessionKey:s.sessionKey,files:s.files.length,requests:s.requests.size,referenceUsd:refs.get(s.sessionKey).cost.totalUsd,marginalUsd:s.results.reduce((a,r)=>a+(r.marginalCostUsd??0),0),nativeUsd:intervals.reduce((a,r)=>a+r.nativeUsd,0),malformed,missingIds,trailingRequests,intervals});processed++;
}
const resets=output.flatMap(s=>s.intervals.filter(r=>r.marginal>0&&Math.abs(r.marginal-r.cost)<1e-7&&r.cost>r.previousCost&&r.previousCost>0).map(r=>({sessionKey:s.sessionKey,...r})));
const classifications={};for(const r of resets){const kind=Math.abs(r.nativeUsd-r.delta)<1e-6?'native-exact-delta':Math.abs(r.nativeUsd-r.marginal)<1e-6?'native-exact-marginal':'unresolved';r.calibration=kind;const b=classifications[kind]??={intervals:0,sessions:new Set(),nativeUsd:0,marginalUsd:0,deltaUsd:0,ledgerExcessUsd:0,unknownRequests:0,fastRequests:0,hostedToolRequests:0,missingTtlWriteTokens:0,versions:{}};b.intervals++;b.sessions.add(r.sessionKey);b.nativeUsd+=r.nativeUsd;b.marginalUsd+=r.marginal;b.deltaUsd+=r.delta;b.ledgerExcessUsd+=r.marginal-r.nativeUsd;for(const key of ['unknownRequests','fastRequests','hostedToolRequests','missingTtlWriteTokens'])b[key]+=r[key];for(const v of r.versions)b.versions[v]=(b.versions[v]??0)+1;}for(const b of Object.values(classifications))b.sessions=b.sessions.size;
const totals={sessions:output.length,files:output.reduce((a,s)=>a+s.files,0),referenceUsd:output.reduce((a,s)=>a+s.referenceUsd,0),marginalUsd:output.reduce((a,s)=>a+s.marginalUsd,0),nativeUsd:output.reduce((a,s)=>a+s.nativeUsd,0),upwardResets:resets.length,resetNativeUsd:resets.reduce((a,r)=>a+r.nativeUsd,0),resetMarginalUsd:resets.reduce((a,r)=>a+r.marginal,0),resetDeltaUsd:resets.reduce((a,r)=>a+r.delta,0)};
fs.writeFileSync('.lane/conductor-marginal-calibration.json',JSON.stringify({cutoff:sem.cutoff,limits:['Native costs use reviewed standard rate cards; fast mode and hosted tool fees are separately flagged, not repriced.','Intervals use native request first timestamps against result timestamps.','Missing native history and unrecorded background requests may make native cost a lower bound.','No marginal ledger is treated as authoritative by this calibration.'],totals,classifications,sessions:output,upwardResets:resets},null,2)+'\n');console.log(JSON.stringify(totals,null,2));
