/** Explain numeric cumulative-only fallback intervals without copying content. */
import{readFileSync,writeFileSync,readdirSync,existsSync,createReadStream}from'node:fs';import{homedir}from'node:os';import{join}from'node:path';import{createHash}from'node:crypto';import{createInterface}from'node:readline';import{DatabaseSync}from'../shared/sqlite.ts';
import { runPrivate, safeTimestamp, safeModel, safeCount, safeHash, safeRepositoryKey } from './codex-safe.mjs';

await runPrivate(async () => {
const raw=JSON.parse(readFileSync('.lane/codex-raw-oracle.json')),accounting=JSON.parse(readFileSync('.lane/codex-accounting.json'));
const targetSessions=new Set(accounting.fallbacks.map(f=>f.sessionKey));
const providerKeys=new Map(raw.fileRows.filter(f=>targetSessions.has(f.sessionKey)).map(f=>[f.providerKey,f.sessionKey]));
const hash=s=>createHash('sha256').update(s).digest('hex').slice(0,12);
const db=new DatabaseSync(join(homedir(),'.codex','state_5.sqlite'),{readOnly:true});const ids=new Map(db.prepare('SELECT id FROM threads').all().filter(r=>providerKeys.has(hash('codex:'+r.id))).map(r=>[r.id,providerKeys.get(hash('codex:'+r.id))]));db.close();
const files=[];function walk(p){if(!existsSync(p))return;for(const e of readdirSync(p,{withFileTypes:true})){const f=join(p,e.name);if(e.isDirectory())walk(f);else for(const[id,key]of ids)if(e.name.includes(id)&&e.name.endsWith('.jsonl'))files.push({path:f,key})}}for(const kind of['sessions','archived_sessions'])walk(join(homedir(),'.codex',kind));
const rates=JSON.parse(readFileSync('data/rate-cards.json')).models;
const intervals=[],usableStates=new Map();
const vals=o=>['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens'].map(k=>Number.isFinite(o?.[k])&&o[k]>=0?o[k]:0);
for(const f of files){let prev=null,prevTime=null,model=null;for await(const line of createInterface({input:createReadStream(f.path),crlfDelay:Infinity})){let r;try{r=JSON.parse(line)}catch{continue}const p=r.payload;if(r.type==='turn_context')model=safeModel(p?.model,rates);if(r.type!=='event_msg'||p?.type!=='token_count'||!p.info?.total_token_usage)continue;const total=vals(p.info.total_token_usage),last=vals(p.info.last_token_usage);if(last[0]+last[2]>0){const key=hash(JSON.stringify([total,last]));usableStates.set(key,{sessionKey:f.key,timestamp:safeTimestamp(r.timestamp),total,last});}
 if(prev&&last[0]+last[2]===0&&total.every((n,i)=>n>=prev[i])){const delta=total.map((n,i)=>n-prev[i]);if(delta[0]+delta[2]>0){const rate=rates[model];const usd=rate?((delta[0]-delta[1])*rate.inputPerMillion+delta[1]*rate.cachedInputPerMillion+delta[2]*rate.outputPerMillion)/1e6:null;intervals.push({sessionKey:f.key,timestamp:safeTimestamp(r.timestamp),previousTimestamp:prevTime,intervalHash:hash(JSON.stringify([prev,total])),previous:prev,total,lastPresent:!!p.info.last_token_usage,last,model:rate?model:'<unpriced>',delta,usd});}}prev=total;prevTime=safeTimestamp(r.timestamp);}}
const seen=new Set(),duplicateIntervals=[];for(const i of intervals){if(seen.has(i.intervalHash))duplicateIntervals.push(i);seen.add(i.intervalHash)}
const explicitCoverageIntervals=[];for(const interval of intervals){let current=interval.total,steps=0,seen=new Set();while(JSON.stringify(current)!==JSON.stringify(interval.previous)){const state=[...usableStates.values()].find(s=>JSON.stringify(s.total)===JSON.stringify(current)&&s.last[0]+s.last[2]>0);if(!state||seen.has(JSON.stringify(current)))break;seen.add(JSON.stringify(current));current=state.total.map((n,i)=>n-state.last[i]);steps++;}if(JSON.stringify(current)===JSON.stringify(interval.previous))explicitCoverageIntervals.push({...interval,explicitRequestChainLength:steps});}
const out={intervals,duplicateIntervals,explicitCoverageIntervals,overcountTokens:[...duplicateIntervals,...explicitCoverageIntervals].reduce((n,i)=>n+i.delta[0]+i.delta[2],0),overcountUsd:[...duplicateIntervals,...explicitCoverageIntervals].reduce((n,i)=>n+(i.usd??0),0),duplicateTokens:duplicateIntervals.reduce((n,i)=>n+i.delta[0]+i.delta[2],0),duplicateUsd:duplicateIntervals.reduce((n,i)=>n+(i.usd??0),0),usableStates:[...usableStates.values()]};
writeFileSync('.lane/codex-fallback-evidence.json',JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify({...out,usableStates:undefined},null,2));

});
