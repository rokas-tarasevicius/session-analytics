/** Independent raw Desktop oracle. No application imports; never emits transcript content or raw IDs/paths. */
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';

async function main(): Promise<void> {

const home = homedir();
const root = join(home, 'Library/Application Support/Claude/local-agent-mode-sessions');
const snapshot = JSON.parse(await readFile(process.argv[2] ?? join(home, 'session-analytics-lanes/reference/snapshot-noindex-51ea561.json'), 'utf8'));
const safeModel = (v: unknown) => ['claude-opus-4-6','claude-haiku-4-5-20251001'].includes(String(v)) ? String(v) : '<unknown>';
const hash = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 12);
const cutoff = Date.parse(snapshot.generatedAt);
const numeric = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
async function files(path: string, depth = 0): Promise<string[]> {
  if (depth > 8) return [];
  let entries; try { entries = await readdir(path, { withFileTypes: true }); } catch { return []; }
  const result: string[] = [];
  for (const e of entries) {
    if (e.isSymbolicLink() || ['.git','node_modules'].includes(e.name)) continue;
    if (e.isDirectory()) result.push(...await files(join(path,e.name),depth+1));
    else if (e.isFile() && /\.jsonl$|^local_.*\.json$/.test(e.name)) result.push(join(path,e.name));
  }
  return result;
}
const sessions = new Map<string, any>();
const metadata: any[] = [];
let ignoredJsonlFiles = 0;
const sourceFiles = await files(root);
for (const file of sourceFiles.filter(p=>p.endsWith('.json'))) {
  try { const d=JSON.parse(await readFile(file,'utf8')); if(typeof d.cliSessionId==='string')metadata.push(d); } catch {}
}
for (const file of sourceFiles.filter(p=>p.endsWith('.jsonl'))) {
  let text; try { text = await readFile(file,'utf8'); } catch { continue; }
  if (file.endsWith('.json')) {
    try { const d=JSON.parse(text); if (typeof d.cliSessionId === 'string') metadata.push(d); } catch {}
    continue;
  }
  let isTranscript = false;
  for (const line of text.split('\n')) {
    let d; try { d=JSON.parse(line); } catch { continue; }
    if (!d || typeof d !== 'object') continue;
    const rawId=d.sessionId ?? d.session_id;
    const id=metadata.find(m=>m.sessionId===rawId)?.cliSessionId ?? rawId;
    if (typeof id !== 'string') continue;
    if (!['assistant','user','system','result','queue-operation','rate_limit_event'].includes(d.type)) continue;
    isTranscript=true;
    const key=hash(`claude:${id}`);
    if (!sessions.has(key)) sessions.set(key, {messages:new Map(),auditMessages:new Map(),files:new Set(),results:[],times:[],cwdPresent:false});
    const s=sessions.get(key); s.files.add(hash(file)); s.cwdPresent ||= typeof d.cwd==='string';
    const time=d.timestamp ?? d._audit_timestamp;
    if (typeof time==='string' && Number.isFinite(Date.parse(time))) s.times.push(Date.parse(time));
    if (d.type==='assistant' && d.message?.usage && typeof d.message.id==='string') {
      const map=basename(file)==='audit.jsonl'? s.auditMessages:s.messages;
      const u=d.message.usage; const next={model:safeModel(d.message.model), input:numeric(u.input_tokens),read:numeric(u.cache_read_input_tokens),write:numeric(u.cache_creation_input_tokens),write5m:numeric(u.cache_creation?.ephemeral_5m_input_tokens),write1h:numeric(u.cache_creation?.ephemeral_1h_input_tokens),output:numeric(u.output_tokens)};
      const prev=map.get(d.message.id);
      if (!prev || next.output>=prev.output) map.set(d.message.id,next);
    }
    if (d.type==='result') s.results.push({totalCostUsd:numeric(d.total_cost_usd),usage:d.usage,modelUsage:d.modelUsage});
  }
  if (!isTranscript) ignoredJsonlFiles++;
}
const publicRows=[];
let identityOnlyGroups=0;
for (const [sessionKey,s] of sessions) {
  if(!s.messages.size&&!s.auditMessages.size&&!s.results.length){identityOnlyGroups++;continue;}
  const totals={input:0,read:0,write:0,write5m:0,write1h:0,output:0};
  const use=s.messages.size?s.messages:s.auditMessages;
  for (const m of use.values()) for (const k of Object.keys(totals)) totals[k as keyof typeof totals]+=m[k];
  const actual=snapshot.sessions.find((x:any)=>x.sessionKey===sessionKey);
  const expected={inputTokens:totals.input+totals.read+totals.write,uncachedInputTokens:totals.input,cachedInputTokens:totals.read,cacheWriteInputTokens:totals.write,cacheWrite5mInputTokens:totals.write5m,cacheWrite1hInputTokens:totals.write1h,outputTokens:totals.output};
  const deltas=actual?Object.fromEntries(Object.entries(expected).map(([k,v])=>[k,actual.tokens[k]-v])):null;
  const models=[...new Set([...use.values()].map((x:any)=>x.model))];
  // Historical Opus 4.6 standard rates, independently fixed here; reported cost is a separate receipt counter.
  const listEstimate=models.every(x=>x==='claude-opus-4-6')?(totals.input*5+totals.read*0.5+totals.write5m*6.25+totals.write1h*10+totals.output*25)/1e6:null;
  const meta=metadata.find(x=>hash(`claude:${x.cliSessionId}`)===sessionKey);
  const auditIds=[...s.auditMessages.keys()];
  publicRows.push({sessionKey,metadataPresent:!!meta,metadataIdEqualsCliId:meta?meta.sessionId===meta.cliSessionId:null,fileCount:s.files.size,nativeMessages:s.messages.size,auditMessages:s.auditMessages.size,auditMessagesDuplicateNative:auditIds.filter(x=>s.messages.has(x)).length,firstEventAt:s.times.length?new Date(Math.min(...s.times)).toISOString():null,lastEventAt:s.times.length?new Date(Math.max(...s.times)).toISOString():null,liveAfterReference:s.times.some((x:number)=>x>cutoff),models,tokens:expected,listEstimateUsd:listEstimate,reportedReceipts:s.results.map((x:any)=>({totalCostUsd:x.totalCostUsd,usageKeys:Object.keys(x.usage??{}).filter(k=>['input_tokens','cache_read_input_tokens','cache_creation_input_tokens','output_tokens','cache_creation','service_tier','server_tool_use','inference_geo','iterations','speed'].includes(k)),modelIds:Object.keys(x.modelUsage??{}).map(safeModel)})),referencePresent:!!actual,referenceRepositoryId:actual?.repositoryId,referenceTokens:actual?.tokens,tokenDeltas:deltas,referenceCost:actual?.cost,referenceAgentIdentity:actual?.agentIdentity,referenceCalls:actual?.metrics?.modelCalls,referenceMonths:[...new Set(Object.keys(actual?.spendByDay??{}).map(x=>x.slice(0,7)))]});
}
console.log(JSON.stringify({oracleVersion:1,referenceGeneratedAt:snapshot.generatedAt,metadataFiles:metadata.length,ignoredJsonlFiles,identityOnlyGroups,sessions:publicRows},null,2));

}
main().catch(() => { process.stderr.write("Desktop validation could not read supported local evidence.\n"); process.exitCode = 1; });
