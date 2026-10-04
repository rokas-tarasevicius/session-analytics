/** Independent validation oracle. Written before reading the application adapters.
 * Sources: pinned Gemini recording service/types and OpenCode v1.2.24 processor/getUsage.
 * Only explicitly selected counters escape; no messages, file paths or raw IDs are printed.
 */
import { createHash } from 'node:crypto';
import { statSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

type Obj = Record<string, any>;
const number = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
export const digest = (id: string): string => createHash('sha256').update(id).digest('hex').slice(0,12);
export function geminiReplay(records: Obj[]): { metadata: Obj; messages: Obj[] } {
  let metadata: Obj = {}; let messages = new Map<string, Obj>();
  const message = (m: Obj) => ({ id:m.id, type:m.type, timestamp:m.timestamp, model:m.model,
    tokens:m.tokens ? {input:m.tokens.input, output:m.tokens.output, cached:m.tokens.cached, thoughts:m.tokens.thoughts, tool:m.tokens.tool, total:m.tokens.total}:undefined,
    toolCalls:Array.isArray(m.toolCalls)?m.toolCalls.map((t: Obj)=>({id:t.id,name:t.name})):[] });
  const add = (m: Obj) => { if (typeof m?.id === 'string') messages.set(m.id,message(m)); };
  for (const r of records) {
    if (typeof r.$rewindTo === 'string') {
      const ids=[...messages.keys()]; const i=ids.indexOf(r.$rewindTo);
      for(const id of i<0?ids:ids.slice(i)) messages.delete(id);
    } else if (r.$patch) {
      // Official patches only mutate message content/tool results; only removals/order affect metrics.
      for(const id of r.$patch.removeIds??[])messages.delete(id);
      if(Array.isArray(r.$patch.orderIds)) {
        const requested=new Set(r.$patch.orderIds); const reordered=new Map([...messages].filter(([id])=>!requested.has(id)));
        for(const id of r.$patch.orderIds)if(messages.has(id))reordered.set(id,messages.get(id)!);
        messages=reordered;
      }
    } else if (typeof r.id==='string') add(r);
    else if (r.$set) {
      if(Array.isArray(r.$set.messages)){messages.clear();for(const m of r.$set.messages)add(m);}
      for(const k of ['sessionId','projectHash','startTime','lastUpdated','kind'])if(k in r.$set)metadata[k]=r.$set[k];
    } else if(typeof r.sessionId==='string'&&typeof r.projectHash==='string') {
      for(const k of ['sessionId','projectHash','startTime','lastUpdated','kind'])if(k in r)metadata[k]=r[k];
      for(const m of r.messages??[])add(m);
    }
  }
  return {metadata,messages:[...messages.values()]};
}
export function geminiCounters(records: Obj[]) {
  const state=geminiReplay(records); const counts={input:0,cacheRead:0,output:0,reasoning:0,userTurns:0,assistantMessages:0,toolCalls:0};
  const calls=new Set<string>();
  for(const m of state.messages) {
    if(m.type==='user')counts.userTurns++;
    if(m.type!=='gemini')continue;
    counts.assistantMessages++; counts.input+=number(m.tokens?.input);counts.cacheRead+=number(m.tokens?.cached);
    counts.output+=number(m.tokens?.output)+number(m.tokens?.thoughts);counts.reasoning+=number(m.tokens?.thoughts);
    for(const t of m.toolCalls)if(typeof t.id==='string')calls.add(t.id);
  }
  counts.toolCalls=calls.size;
  return counts;
}
export function openCodeCounters(messages: Obj[], parts: Obj[]) {
  const counts={input:0,cacheRead:0,cacheWrite:0,output:0,reasoning:0,userTurns:0,assistantMessages:0,toolCalls:0,requests:0};
  const calls=new Set<string>();
  const add=(t: Obj)=>{counts.requests++;counts.input+=number(t.input)+number(t.cache?.read)+number(t.cache?.write);counts.cacheRead+=number(t.cache?.read);counts.cacheWrite+=number(t.cache?.write);counts.output+=number(t.output);counts.reasoning+=number(t.reasoning);};
  for(const m of messages){if(m.role==='user')counts.userTurns++;if(m.role!=='assistant')continue;counts.assistantMessages++;
    const steps=parts.filter(p=>p.message_id===m.id&&p.type==='step-finish'&&p.tokens);
    if(steps.length)for(const p of steps)add(p.tokens);else if(m.tokens)add(m.tokens);
  }
  for(const p of parts)if(p.type==='tool'&&typeof p.callID==='string')calls.add(p.callID);
  counts.toolCalls=calls.size; return counts;
}
export function copilotCounters(events: Obj[]) {
  const counts={userTurns:0,assistantMessages:0,toolCalls:0,compactions:0};const ids=new Set<string>();const messages=new Set<string>();const tools=new Set<string>();
  for(const e of events){if(e.ephemeral===true)continue;if(typeof e.id==='string'){if(ids.has(e.id))continue;ids.add(e.id);}
    if(e.type==='user.message')counts.userTurns++;
    if(e.type==='assistant.message'&&typeof e.data?.messageId==='string')messages.add(e.data.messageId);
    if(e.type==='tool.execution_start'&&typeof e.data?.toolCallId==='string')tools.add(e.data.toolCallId);
    if(e.type==='session.compaction_complete'&&e.data?.success===true)counts.compactions++;
  }
  counts.assistantMessages=messages.size;counts.toolCalls=tools.size;return counts;
}
function present(path: string): boolean {
  try { statSync(path); return true; }
  catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT')return false; throw error; }
}
function walk(root: string): string[]{
  if(!present(root))return [];
  const out:string[]=[];
  for(const d of readdirSync(root,{withFileTypes:true})){if(d.isSymbolicLink())continue;const p=join(root,d.name);if(d.isDirectory())out.push(...walk(p));else if(d.isFile())out.push(p);}
  return out;
}
export function auditAbsentAdapters(snapshotPath: string,h=homedir(),environment:NodeJS.ProcessEnv=process.env){
  const roots={copilot:join(h,'.copilot','session-state'),opencode:join(environment.XDG_DATA_HOME??join(h,'.local','share'),'opencode'),gemini:join(h,'.gemini','tmp')};
  const snapshot=JSON.parse(readFileSync(snapshotPath,'utf8'));const rows:Obj[]=[];
  function collect(v:any){if(!v||typeof v!=='object')return;if(typeof v.sessionKey==='string'&&typeof v.provider==='string')rows.push(v);else for(const x of Object.values(v))collect(x);}
  collect(snapshot);const dedup=[...new Map(rows.map(s=>[s.sessionKey,s])).values()];
  const providers=Object.entries(roots).map(([provider,root])=>({provider,rootExists:present(root),historyFiles:walk(root).filter(p=>provider==='gemini'?/\/chats\/session-.*\.jsonl?$/.test(p):provider==='copilot'?p.endsWith('/events.jsonl'):p.endsWith('/opencode.db')).length,referenceSessions:dedup.filter(s=>s.provider===provider).length}));
  const empty=providers.every(p=>p.historyFiles===0&&p.referenceSessions===0);
  return {method:'independent on-disk existence and file inventory; empty-set snapshot reconciliation',status:empty?'verified-empty-population':'requires-populated-history-reconciliation',providers,
    limitations:empty?['No local Copilot/OpenCode/Gemini CLI history found; real token/USD differences for these adapters are zero, future-format correctness is synthetic/upstream-source validated.']:['Native history or reference sessions are present. This empty-population inventory is insufficient; run a populated-history oracle before drawing accounting conclusions.']};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{console.log(JSON.stringify(auditAbsentAdapters(process.argv[2]??join(homedir(),'session-analytics-lanes','reference','snapshot-noindex-51ea561.json')),null,2));}
  catch{console.error('Adapter oracle failed; raw error suppressed.');process.exitCode=1;}
}
