/** Targeted second-phase explanation of the aggregate discrepancy. */
import{readFileSync,writeFileSync,readdirSync,existsSync,createReadStream,realpathSync}from'node:fs';
import{homedir}from'node:os';import{join,basename}from'node:path';import{createHash}from'node:crypto';import{createInterface}from'node:readline';import{DatabaseSync}from'../shared/sqlite.ts';
import { runPrivate, safeTimestamp, safeModel, safeCount, safeHash, safeRepositoryKey } from './codex-safe.mjs';

await runPrivate(async () => {
const raw=JSON.parse(readFileSync('.lane/codex-raw-oracle.json'));
const groups=new Map();for(const f of raw.fileRows){const g=groups.get(f.sessionKey)??[];g.push(f);groups.set(f.sessionKey,g)}
const targets=new Set([...groups.values()].filter(g=>g.length>1).map(g=>g[0].providerKey));
const db=new DatabaseSync(join(homedir(),'.codex','state_5.sqlite'),{readOnly:true});
const hash=s=>createHash('sha256').update(s).digest('hex').slice(0,12);
const rows=db.prepare('SELECT id, rollout_path, tokens_used FROM threads').all().filter(r=>targets.has(hash(`codex:${r.id}`)));db.close();
const rowByKey=new Map(rows.map(r=>[hash(`codex:${r.id}`),r]));
const ids=new Map(rows.map(r=>[r.id,hash(`codex:${r.id}`)]));
const files=[];function walk(p){if(!existsSync(p))return;for(const e of readdirSync(p,{withFileTypes:true})){const f=join(p,e.name);if(e.isDirectory())walk(f);else for(const[id,k]of ids)if(e.name.includes(id)&&e.name.endsWith('.jsonl'))files.push({path:f,key:k})}}
for(const kind of ['sessions','archived_sessions'])walk(join(homedir(),'.codex',kind));
const rates=JSON.parse(readFileSync('data/rate-cards.json')).models;
const parsed=[];
for(const file of files){let model=null,first=null,last=null,records=0,metadataCwdHash=null,metadataIdMatchesDatabase=false;const states=new Map();
 for await(const line of createInterface({input:createReadStream(file.path),crlfDelay:Infinity})){let r;try{r=JSON.parse(line)}catch{continue}const p=r.payload;if(r.type==='session_meta'){metadataCwdHash=typeof p?.cwd==='string'?hash(p.cwd):null;metadataIdMatchesDatabase=p?.id===rowByKey.get(file.key).id;}if(safeTimestamp(r.timestamp)){first??=safeTimestamp(r.timestamp);last=safeTimestamp(r.timestamp)}if(r.type==='turn_context'&&p&&Object.hasOwn(p,'model'))model=safeModel(p.model,rates);if(r.type!=='event_msg'||p?.type!=='token_count'||!p.info?.total_token_usage||!p.info.last_token_usage)continue;records++;const total=p.info.total_token_usage,l=p.info.last_token_usage;const vals=o=>['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens'].map(k=>Number.isFinite(o[k])&&o[k]>=0?o[k]:0);const state=JSON.stringify([vals(total),vals(l)]);if(!states.has(state))states.set(state,{model,timestamp:safeTimestamp(r.timestamp),input:safeCount(l.input_tokens),cached:safeCount(l.cached_input_tokens),output:safeCount(l.output_tokens),reasoning:safeCount(l.reasoning_output_tokens)});}
 const dbRow=rowByKey.get(file.key);
 parsed.push({key:file.key,first,last,records,states,sourceProof:{metadataCwdHash,metadataIdMatchesDatabase,filenameHash:hash(basename(file.path)),filenameUuidCount:basename(file.path).match(/[0-9a-f]{8}-[0-9a-f-]{27}/ig)?.length??0,filenameEndsWithMetadataId:basename(file.path).endsWith(dbRow.id+'.jsonl'),sqliteRolloutPointerMatches:realpathSync(file.path)===realpathSync(dbRow.rollout_path),sqliteTokensUsed:dbRow.tokens_used}});
}
parsed.sort((a,b)=>a.first.localeCompare(b.first));
const all=new Map(),segments=[],segmentStates=[];for(const f of parsed){const tokens={input:0,cached:0,output:0,reasoning:0},models={},months={};let unique=0,overlap=0,usd=0,longContextRequests=0,unpriced=0;
 for(const[state,v]of f.states){if(all.has(state)){overlap++;continue}all.set(state,v);unique++;for(const k of Object.keys(tokens))tokens[k]+=v[k];const rt=rates[v.model];const isLong=rt?.longContext&&v.input>rt.longContext.thresholdInputTokens;let cost=null;if(rt){const im=isLong?rt.longContext.inputMultiplier:1,om=isLong?rt.longContext.outputMultiplier:1;cost=((v.input-v.cached)*rt.inputPerMillion*im+v.cached*rt.cachedInputPerMillion*im+v.output*rt.outputPerMillion*om)/1e6;usd+=cost;if(isLong)longContextRequests++}else unpriced++;
 segmentStates.push({stateHash:hash(state),segmentFirstAt:f.first,sessionKey:f.key,...v,usd:cost});
 const mb=models[v.model??'<unknown>']??={requests:0,input:0,cached:0,output:0,usd:0};mb.requests++;for(const k of ['input','cached','output'])mb[k]+=v[k];mb.usd+=cost??0;const m=v.timestamp?.slice(0,7)??'undated';const b=months[m]??={requests:0,input:0,output:0,usd:0};b.requests++;b.input+=v.input;b.output+=v.output;b.usd+=cost??0;}
 segments.push({sessionKey:f.key,sourceProof:f.sourceProof,firstAt:f.first,lastAt:f.last,observedStates:f.states.size,uniqueStates:unique,overlapStates:overlap,tokens,usd,longContextRequests,unpriced,models,months});
}
const out={segments,interpretation:'Segments ordered by first event. Each segment reports exact physical-counter states not previously seen in earlier segments; prices use reviewed rate cards and per-request long-context thresholds. Global cross-session overlap must be separately checked.'};
writeFileSync('.lane/codex-segment-evidence.json',JSON.stringify(out,null,2)+'\n');writeFileSync('.lane/codex-segment-states.json',JSON.stringify(segmentStates)+'\n');console.log(JSON.stringify(out,null,2));

});
