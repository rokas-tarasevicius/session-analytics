/** Raw Desktop result reconciliation oracle. No application imports; no content leaves this process. */
import { readdir,readFile } from 'node:fs/promises';
import { join,basename } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

async function main(): Promise<void> {
const home=homedir(),root=join(home,'Library/Application Support/Claude/local-agent-mode-sessions');
const snapshot=JSON.parse(await readFile(process.argv[2]??join(home,'session-analytics-lanes/reference/snapshot-noindex-51ea561.json'),'utf8'));
const safeModel=(v:unknown)=>['claude-opus-4-6','claude-haiku-4-5-20251001'].includes(String(v))?String(v):'<unknown>';
const num=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:0;
const safeTimestamp=(v:unknown)=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT/.test(v)&&Number.isFinite(Date.parse(v))?new Date(v).toISOString():null;
const hash=(s:string)=>createHash('sha256').update(s).digest('hex').slice(0,12);
async function files(root:string,depth=0):Promise<string[]>{if(depth>8)return[];let entries;try{entries=await readdir(root,{withFileTypes:true});}catch{return[];}const out:string[]=[];for(const e of entries){if(e.isSymbolicLink()||['.git','plugins','node_modules'].includes(e.name))continue;const p=join(root,e.name);if(e.isDirectory())out.push(...await files(p,depth+1));else if(e.isFile()&&e.name.endsWith('.jsonl'))out.push(p);}return out;}
async function records(p:string){const rows=[];for(const l of(await readFile(p,'utf8')).split('\n'))try{rows.push(JSON.parse(l));}catch{}return rows;}
const paths=await files(root),native=new Map<string,any>();
for(const p of paths.filter(p=>/^[0-9a-f]{8}-[0-9a-f-]{27}\.jsonl$/i.test(basename(p))))for(const d of await records(p)){
 if(d.type!=='assistant'||typeof d.message?.id!=='string'||!d.message.usage)continue;
 const key=`${d.sessionId}:${d.message.id}`,old=native.get(key);
 if(!old||d.message.usage.output_tokens>=old.usage.output_tokens)native.set(key,{model:safeModel(d.message.model),usage:d.message.usage});
}
const rows:any[]=[];
for(const p of paths.filter(p=>basename(p)==='audit.jsonl')){
 let interval:any=null;const intervals:any[]=[];const seenInit=new Set<string>(),seenResult=new Set<string>();
 for(const d of await records(p)){
  if(d.type==='system'&&d.subtype==='init'&&typeof d.uuid==='string'&&typeof d.session_id==='string'){
   if(seenInit.has(d.uuid)){interval=null;continue;}seenInit.add(d.uuid);
   interval={id:d.session_id,version:d.claude_code_version,messages:new Set<string>(),result:null};intervals.push(interval);
  }
  if(!interval||d.session_id!==interval.id)continue;
  if(d.type==='assistant'&&typeof d.message?.id==='string')interval.messages.add(d.message.id);
  if(d.type==='result'&&typeof d.uuid==='string'&&!seenResult.has(d.uuid)){seenResult.add(d.uuid);interval.result=d;}
 }
 const seenNative=new Set<string>();
 for(const int of intervals){
  const d=int.result;if(!d)continue;
  const parsed=/^2\.1\.(\d+)$/.exec(int.version??'');const supported=!!parsed&&Number(parsed[1])<277;
  const nativeModels=new Map<string,any>();let overlapping=0,missingNative=0;
  for(const id of int.messages){const key=`${int.id}:${id}`;if(seenNative.has(key))overlapping++;seenNative.add(key);const m=native.get(key);if(!m){missingNative++;continue;}const total=nativeModels.get(m.model)??{input:0,read:0,write:0,output:0};for(const [to,from] of Object.entries({input:'input_tokens',read:'cache_read_input_tokens',write:'cache_creation_input_tokens',output:'output_tokens'}))total[to]+=num(m.usage[from]);nativeModels.set(m.model,total);}
  const models=[];
  for(const [model,u] of Object.entries(d.modelUsage??{}) as [string,any][]){const n=nativeModels.get(model)??{input:0,read:0,write:0,output:0};const usage={input:num(u.inputTokens),read:num(u.cacheReadInputTokens),write:num(u.cacheCreationInputTokens),output:num(u.outputTokens)};const delta=Object.fromEntries(Object.keys(n).map(k=>[k,usage[k as keyof typeof usage]-n[k]]));const nativePresent=nativeModels.has(model);const inputsMatch=!nativePresent||(delta.input===0&&delta.read===0&&delta.write===0);const rate=model==='claude-opus-4-6'?{input:5,output:25}:model==='claude-haiku-4-5-20251001'?{input:1,output:5}:null;const knownCost=rate&&delta.read===0&&delta.write===0?(delta.input!*rate.input+delta.output!*rate.output)/1e6:null;models.push({model:safeModel(model),nativePresent,native:n,receipt:usage,delta,inputsMatch,missingTokens:Object.values(delta).reduce((a,b)=>a+b,0),missingApiEquivalentUsd:knownCost,sdkEstimatedCostUsd:typeof u.costUSD==='number'&&Number.isFinite(u.costUSD)?u.costUSD:null});}
  rows.push({sessionKey:hash(`claude:${int.id}`),version:parsed?int.version:null,preResumeCarryoverVersion:supported,endedAt:safeTimestamp(d._audit_timestamp),liveAfterReference:Date.parse(d._audit_timestamp)>Date.parse(snapshot.generatedAt),nativeMessageCount:int.messages.size,overlappingNativeMessages:overlapping,missingNativeMessages:missingNative,resultRecordsDeduplicated:true,models,referencePresent:snapshot.sessions.some((s:any)=>s.sessionKey===hash(`claude:${int.id}`))});
 }
}
const bySession=new Map<string,any>();for(const r of rows){const a=bySession.get(r.sessionKey)??{sessionKey:r.sessionKey,intervals:0,missingTokens:0,missingApiEquivalentUsd:0};a.intervals++;for(const m of r.models){a.missingTokens+=m.missingTokens;a.missingApiEquivalentUsd+=m.missingApiEquivalentUsd??0;}bySession.set(r.sessionKey,a);}
console.log(JSON.stringify({oracleVersion:1,referenceGeneratedAt:snapshot.generatedAt,rates:{'claude-opus-4-6':{input:5,output:25},'claude-haiku-4-5-20251001':{input:1,output:5}},intervals:rows,bySession:[...bySession.values()],missingTokens:[...bySession.values()].reduce((a,b)=>a+b.missingTokens,0),missingApiEquivalentUsd:[...bySession.values()].reduce((a,b)=>a+b.missingApiEquivalentUsd,0)},null,2));

}
main().catch(() => { process.stderr.write("Desktop validation could not read supported local evidence.\n"); process.exitCode = 1; });
