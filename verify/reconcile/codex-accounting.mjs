/** Second-phase validation of global physical-counter dedup and cumulative fallback. */
import{readFileSync,writeFileSync,readdirSync,existsSync,createReadStream}from'node:fs';
import{homedir}from'node:os';import{join}from'node:path';import{createHash}from'node:crypto';import{createInterface}from'node:readline';
import { runPrivate, safeTimestamp, safeModel, safeCount, safeHash, safeRepositoryKey } from './codex-safe.mjs';

await runPrivate(async () => {
const raw=JSON.parse(readFileSync('.lane/codex-raw-oracle.json'));
const segments=JSON.parse(readFileSync('.lane/codex-segment-evidence.json')).segments;
const segmentStates=JSON.parse(readFileSync('.lane/codex-segment-states.json'));
const byProvider=new Map(raw.fileRows.map(r=>[r.providerKey,r]));
const duplicates=new Map();for(const f of raw.fileRows){const a=duplicates.get(f.providerKey)??[];a.push(f);duplicates.set(f.providerKey,a)}
const firstByKey=new Map([...duplicates].filter(([,a])=>a.length>1).map(([k,a])=>[k,a.map(x=>x.firstAt).sort()[0]]));
const hash=s=>createHash('sha256').update(s).digest('hex').slice(0,12);
const paths=[];function walk(p){if(!existsSync(p))return;for(const e of readdirSync(p,{withFileTypes:true})){const f=join(p,e.name);if(e.isDirectory())walk(f);else if(e.name.endsWith('.jsonl'))paths.push(f)}}
for(const kind of ['sessions','archived_sessions'])walk(join(homedir(),'.codex',kind));
const all=new Map(),selected=new Set(),fallbacks=[],months={};let scanned=0,scalarMismatches=0;
const vals=o=>['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens'].map(k=>typeof o?.[k]==='number'&&Number.isFinite(o[k])&&o[k]>=0?o[k]:0);
for(const path of paths){const id=path.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[0-9a-f]{8}-[0-9a-f-]{27})?\.jsonl$/i)?.[1];if(!id)continue;const providerKey=hash(`codex:${id}`),f=byProvider.get(providerKey);if(!f||f.afterCutoff)continue;
 let firstAt=null,isSelected=true,previous=null;
 for await(const line of createInterface({input:createReadStream(path),crlfDelay:Infinity})){
  if(firstAt===null){const m=line.match(/^\{"timestamp":"([^"]+)"/);if(m){firstAt=m[1];isSelected=!firstByKey.has(providerKey)||firstByKey.get(providerKey)===firstAt;}}
  if(!line.includes('"token_count"'))continue;
  let r;try{r=JSON.parse(line)}catch{continue}const p=r.payload;if(r.type!=='event_msg'||p?.type!=='token_count'||!p.info?.total_token_usage)continue;
  const t=vals(p.info.total_token_usage),l=vals(p.info.last_token_usage);
  const monotonic=previous&&t.every((n,i)=>n>=previous[i]);
  if(l[0]+l[2]===0&&monotonic){const d=t.map((n,i)=>n-previous[i]);if(d[0]+d[2]>0)fallbacks.push({sessionKey:f.sessionKey,selected:isSelected,timestamp:safeTimestamp(r.timestamp),input:d[0],cached:d[1],output:d[2],reasoning:d[3]});}
  previous=t;
  if(!p.info.last_token_usage||l[0]+l[2]===0)continue;
  if((p.info.last_token_usage.total_tokens??l[0]+l[2])!==l[0]+l[2])scalarMismatches++;
  const state=JSON.stringify([t,l]),h=hash(state);if(isSelected)selected.add(h);
  const prior=all.get(h);if(!prior)all.set(h,{input:l[0],cached:l[1],output:l[2],reasoning:l[3],timestamp:safeTimestamp(r.timestamp)});else if(safeTimestamp(r.timestamp)&&(!prior.timestamp||safeTimestamp(r.timestamp)<prior.timestamp))prior.timestamp=safeTimestamp(r.timestamp);
 }
 scanned++;if(scanned%1000===0)process.stderr.write(JSON.stringify({progressFiles:scanned})+'\n');
}
const total={input:0,cached:0,output:0,reasoning:0},selectedTotal={input:0,cached:0,output:0,reasoning:0};
for(const[h,v]of all){for(const k of Object.keys(total)){total[k]+=v[k];if(selected.has(h))selectedTotal[k]+=v[k]}const m=v.timestamp?.slice(0,7)??'undated';const b=months[m]??={input:0,output:0,selectedInput:0,selectedOutput:0,fallbackInput:0,fallbackOutput:0};b.input+=v.input;b.output+=v.output;if(selected.has(h)){b.selectedInput+=v.input;b.selectedOutput+=v.output}}
for(const f of fallbacks)if(f.selected){const m=f.timestamp?.slice(0,7)??'undated';const b=months[m]??={input:0,output:0,selectedInput:0,selectedOutput:0,fallbackInput:0,fallbackOutput:0};b.fallbackInput+=f.input;b.fallbackOutput+=f.output}
const missingStates=segmentStates.filter(s=>s.input+s.output>0&&!selected.has(s.stateHash));
const missing={requests:missingStates.length,input:0,cached:0,output:0,reasoning:0,usd:0,models:{}};for(const s of missingStates){for(const k of ['input','cached','output','reasoning','usd'])missing[k]+=s[k];const b=missing.models[s.model]??={requests:0,input:0,cached:0,output:0,usd:0};b.requests++;for(const k of ['input','cached','output','usd'])b[k]+=s[k];}
const out={scanned,uniquePhysicalStates:all.size,selectedPhysicalStates:selected.size,scalarMismatchObservations:scalarMismatches,total,selectedTotal,fallbacks,months,missing,missingStates,segments};
writeFileSync('.lane/codex-accounting.json',JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify({...out,missingStates:undefined},null,2));

});
