/** Independent raw-source registration/identity oracle. Imports no analyzer code.
 * Output contains hashes, scalar counters/timestamps/model names only. */
import { DatabaseSync } from '../shared/sqlite.ts';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { readdirSync, realpathSync, openSync, closeSync, readSync, statSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
process.on('uncaughtException',()=>{ console.error('Conductor validation could not complete a local read.'); process.exitCode=1; });
const home=homedir();
const key=(x:string)=>createHash('sha256').update(x).digest('hex').slice(0,12);
const iso=(x:unknown)=>{ const n=typeof x==='number'?x:typeof x==='string'?Date.parse(x):NaN; return Number.isFinite(n)?new Date(n).toISOString():null; };
const snapshot=JSON.parse(readFileSync(process.argv[2]??'../reference/snapshot-noindex-51ea561.json','utf8'));
const cutoff=Date.parse(snapshot.generatedAt);
const ref=new Map<string,any>(snapshot.sessions.map((s:any)=>[s.sessionKey,s]));
type Candidate={provider:string,id:string,cwds:Set<string>,first:string|null,last:string|null,files:number};
const candidates=new Map<string,Candidate>(); let files=0,headerFailures=0;
const visited=new Set<string>();
function walk(root:string,visit:(p:string)=>void) { let entries;try {const real=realpathSync(root);if(visited.has(real))return;visited.add(real);entries=readdirSync(root,{withFileTypes:true});}catch{return;}for(const e of entries){const p=join(root,e.name);if(e.isDirectory())walk(p,visit);else if(e.isFile()&&e.name.endsWith('.jsonl'))visit(p);} }
function inspect(file:string,provider:string){
  if(provider==='claude'&&file.split('/').includes('subagents'))return;
  files++; const fd=openSync(file,'r');const size=statSync(file).size; const first=Buffer.alloc(Math.min(size,1024*1024));readSync(fd,first,0,first.length,0);const last=Buffer.alloc(Math.min(size,1024*1024));readSync(fd,last,0,last.length,Math.max(0,size-last.length));closeSync(fd);
  let id:string|null=null;const cwds=new Set<string>();let start:string|null=null,end:string|null=null;
  const lines=first.toString('utf8').split('\n');if(first.length<size)lines.pop();const tail=last.toString('utf8').split('\n');if(last.length<size)tail.shift();
  for(const line of [...lines,...tail]){let r:any;try{r=JSON.parse(line);}catch{continue;}if(!r||typeof r!=='object')continue;const t=iso(r.timestamp);if(t){if(!start||t<start)start=t;if(!end||t>end)end=t;}
    if(provider==='codex'&&r.type==='session_meta'){if(typeof r.payload?.id==='string')id??=r.payload.id;if(typeof r.payload?.cwd==='string')cwds.add(resolve(r.payload.cwd));}
    if(provider==='claude'){if(typeof r.sessionId==='string')id??=r.sessionId;if(typeof r.cwd==='string')cwds.add(resolve(r.cwd));}
  }
  if(!id){headerFailures++;return;}const k=`${provider}:${id}`;const c=candidates.get(k)??{provider,id,cwds:new Set<string>(),first:null,last:null,files:0};for(const cwd of cwds)c.cwds.add(cwd);if(start&&(!c.first||start<c.first))c.first=start;if(end&&(!c.last||end>c.last))c.last=end;c.files++;candidates.set(k,c);
}
for(const d of readdirSync(home)){if(/^\.claude(?:-|$)/.test(d))walk(join(home,d,'projects'),p=>inspect(p,'claude'));if(/^\.codex(?:-|$)/.test(d)){walk(join(home,d,'sessions'),p=>inspect(p,'codex'));walk(join(home,d,'archived_sessions'),p=>inspect(p,'codex'));}}
walk(join(home,'.config','claude','projects'),p=>inspect(p,'claude'));
if(process.env.CLAUDE_CONFIG_DIR)walk(join(process.env.CLAUDE_CONFIG_DIR,'projects'),p=>inspect(p,'claude'));
if(process.env.CODEX_HOME){walk(join(process.env.CODEX_HOME,'sessions'),p=>inspect(p,'codex'));walk(join(process.env.CODEX_HOME,'archived_sessions'),p=>inspect(p,'codex'));}
console.log(JSON.stringify({stage:'provider-inventory-complete',files,headerFailures,candidateIdentities:candidates.size}));
const db=new DatabaseSync(join(home,'Library','Application Support','com.conductor.app','conductor.db'),{readOnly:true});
const rows=db.prepare(`select s.id,s.agent_type,s.claude_session_id,s.created_at,s.updated_at,s.status,w.workspace_path,w.repository_id from sessions s left join workspaces w on s.workspace_id=w.id`).all() as any[];
const usage=(s:any)=>s?{tokens:s.tokens,cost:s.cost,month:(s.firstEventAt??s.createdAt??'unknown').slice(0,7)}:null;
const projected=rows.map(r=>{const c=r.claude_session_id?candidates.get(`${r.agent_type}:${r.claude_session_id}`):null;const registered=ref.get(key(r.id));const discovered=r.claude_session_id?ref.get(key(`${r.agent_type}:${r.claude_session_id}`)):null;const live=!!c?.last&&Date.parse(c.last)>cutoff;return {sessionKey:key(r.id),provider:r.agent_type,providerKey:r.claude_session_id?key(`${r.agent_type}:${r.claude_session_id}`):null,hasProviderId:!!r.claude_session_id,hasCanonical:!!c,canonicalFiles:c?.files??0,cwdMatches:!!c&&typeof r.workspace_path==='string'&&c.cwds.has(resolve(r.workspace_path)),live,registeredPresent:!!registered,discoveredPresent:!!discovered,registeredUsage:usage(registered),discoveredUsage:usage(discovered)};});
// Independently enumerate plausible unique legacy matches. Report all distances; no magic tolerance is assumed.
const legacy=rows.filter(r=>!r.claude_session_id&&typeof r.workspace_path==='string').map(r=>{const created=Date.parse(r.created_at);const same=[...candidates.values()].filter(c=>c.provider===r.agent_type&&c.cwds.has(resolve(r.workspace_path)));const matches=same.map(c=>({providerKey:key(`${c.provider}:${c.id}`),deltaSeconds:c.first?Math.abs(Date.parse(c.first)-created)/1000:null,live:!!c.last&&Date.parse(c.last)>cutoff,canonicalFiles:c.files})).filter(c=>c.deltaSeconds!==null&&c.deltaSeconds<=3600).sort((a,b)=>a.deltaSeconds!-b.deltaSeconds!);return{sessionKey:key(r.id),provider:r.agent_type,registeredPresent:ref.has(key(r.id)),matches};});
// Select terminal result envelopes at the DB boundary; no message content is retained.
const resultRows=db.prepare(`select session_id, created_at, json_extract(content,'$.session_id') provider_id, json_extract(content,'$.uuid') receipt_id, json_extract(content,'$.total_cost_usd') usd, json_extract(content,'$.modelUsage') model_usage from session_messages where (instr(content,'"type":"result"')>0 or instr(content,'"type": "result"')>0) and json_valid(content) and json_extract(content,'$.type')='result'`).all() as any[];
const registeredById=new Map(rows.map(r=>[r.id,r]));
const resultGroups=new Map<string,{rows:Set<string>,receipts:Set<string>,maxUsd:number,models:Set<string>,last:string|null}>();
let resultCount=0;
for(const r of resultRows){const t=iso(r.created_at);if(t&&Date.parse(t)>cutoff)continue;if(typeof r.provider_id!=='string'||!r.provider_id)continue;resultCount++;const provider=registeredById.get(r.session_id)?.agent_type; if(!['claude','codex','cursor'].includes(provider))continue;const k=`${provider}:${r.provider_id}`;const g=resultGroups.get(k)??{rows:new Set<string>(),receipts:new Set<string>(),maxUsd:0,models:new Set<string>(),last:null};g.rows.add(r.session_id);if(typeof r.receipt_id==='string')g.receipts.add(r.receipt_id);if(typeof r.usd==='number'&&Number.isFinite(r.usd))g.maxUsd=Math.max(g.maxUsd,r.usd);if(t&&(!g.last||t>g.last))g.last=t;try{for(const m of Object.keys(JSON.parse(r.model_usage??'{}')))g.models.add(m);}catch{}resultGroups.set(k,g);}
const results=[...resultGroups].map(([identity,g])=>({provider:identity.split(':')[0],providerKey:key(identity),hasCanonical:candidates.has(identity),live:!!candidates.get(identity)?.last&&Date.parse(candidates.get(identity)!.last!)>cutoff,registeredSessionKeys:[...g.rows].map(key).sort(),receipts:g.receipts.size,maxReportedUsd:g.maxUsd,models:[...g.models].sort(),last:g.last,representedKeys:[...g.rows].map(key).filter(k=>ref.has(k)),discoveredPresent:ref.has(key(identity))}));
const data={method:'Independent provider metadata and raw Conductor registration/result identity join; no analyzer imports',generatedAt:snapshot.generatedAt,inventory:{files,headerFailures,candidateIdentities:candidates.size,registeredRows:rows.length,resultCount,resultIdentities:results.length},registrations:projected,legacy,results};
writeFileSync('.lane/conductor-oracle.json',JSON.stringify(data,null,2)+'\n');
console.log(JSON.stringify({inventory:data.inventory,registrationCounts:{canonical:projected.filter(r=>r.hasCanonical).length,registered:projected.filter(r=>r.registeredPresent).length,canonicalMissing:projected.filter(r=>r.hasCanonical&&!r.live&&!r.registeredPresent&&!r.discoveredPresent).length,bothKeys:projected.filter(r=>r.registeredPresent&&r.discoveredPresent).length,cwdMismatch:projected.filter(r=>r.hasCanonical&&!r.cwdMatches).length},results:{identities:results.length,canonical:results.filter(r=>r.hasCanonical).length,multipleRows:results.filter(r=>r.registeredSessionKeys.length>1).length,multipleRepresented:results.filter(r=>r.representedKeys.length+(r.discoveredPresent?1:0)>1).length},legacy:{rows:legacy.length,withinHour:legacy.filter(r=>r.matches.length>0).length}},null,2));
