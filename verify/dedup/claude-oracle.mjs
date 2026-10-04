// Independent raw-record oracle. Deliberately imports no application code.
// Output is an explicit metadata/counter projection; raw records never leave this process.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {DatabaseSync} from '../shared/sqlite.ts';

const hash = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
const home = os.homedir();
const snapshot = JSON.parse(fs.readFileSync(process.argv[2] || '../reference/snapshot-noindex-51ea561.json', 'utf8'));
const cutoff = Date.parse(snapshot.generatedAt);
// JSONL is delimited by LF. Node 24 readline also splits CR/U+2028/U+2029,
// including Unicode separators that are legal inside JSON strings.
async function* lfLines(stream) {
  let pending='';
  for await (const chunk of stream) {
    pending+=chunk;
    let start=0;
    for (;;) { const end=pending.indexOf('\n',start); if (end<0) break; yield pending.slice(start,end); start=end+1; }
    pending=pending.slice(start);
  }
  if (pending) yield pending;
}
const {price: priceIndependent} = await import('../claude/pricing.mjs');
const refs = new Map(snapshot.sessions.filter(s => s.provider === 'claude').map(s => [s.sessionKey, s]));
const registrations = new Map();
const legacyRows = [];
try {
  const db = new DatabaseSync(path.join(home, 'Library/Application Support/com.conductor.app/conductor.db'), {readOnly: true});
  for (const r of db.prepare('SELECT id, claude_session_id FROM sessions WHERE agent_type = ?').all('claude')) {
    if (!r.claude_session_id) continue;
    const keys = registrations.get(r.claude_session_id) || [];
    keys.push(hash(r.id)); registrations.set(r.claude_session_id, keys);
  }
  for (const r of db.prepare('SELECT s.id, s.created_at, w.workspace_path FROM sessions s JOIN workspaces w ON w.id=s.workspace_id WHERE s.agent_type=? AND (s.claude_session_id IS NULL OR s.claude_session_id=?)').all('claude','')) legacyRows.push(r);
  db.close();
} catch { /* Missing optional DB does not disable the independent transcript oracle. */ }
const keyFor = id => (registrations.get(id) || []).find(k => refs.has(k)) || hash(`claude:${id}`);
const counters = ['inputTokens', 'uncachedInputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'cacheWrite5mInputTokens', 'cacheWrite1hInputTokens', 'outputTokens', 'reasoningOutputTokens'];
const empty = () => Object.fromEntries(counters.map(k => [k, 0]));
const add = (a, b, sign = 1) => { for (const k of counters) a[k] += sign * (b[k] || 0); return a; };
const n = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
function usage(u) {
  const one = n(u.cache_creation?.ephemeral_1h_input_tokens);
  // Follow the stronger raw breakdown when its disjoint TTL buckets exceed the summary.
  // Initial oracle used only the summary: three stable sessions differed by 4,137 tokens.
  const w = Math.max(n(u.cache_creation_input_tokens), one + n(u.cache_creation?.ephemeral_5m_input_tokens));
  const five = typeof u.cache_creation?.ephemeral_5m_input_tokens === 'number' ? n(u.cache_creation.ephemeral_5m_input_tokens) : Math.max(0, w - one);
  return {inputTokens:n(u.input_tokens) + n(u.cache_read_input_tokens) + w, uncachedInputTokens:n(u.input_tokens), cachedInputTokens:n(u.cache_read_input_tokens), cacheWriteInputTokens:w, cacheWrite5mInputTokens:five, cacheWrite1hInputTokens:one, outputTokens:n(u.output_tokens), reasoningOutputTokens:n(u.output_tokens_details?.thinking_tokens)};
}
function price(m) {
  const u=m.tokens;
  return priceIndependent(m.model,{input:u.uncachedInputTokens,cacheRead:u.cachedInputTokens,cacheWrite5m:u.cacheWrite5mInputTokens,cacheWrite1h:u.cacheWrite1hInputTokens,cacheWriteUnknown:Math.max(0,u.cacheWriteInputTokens-u.cacheWrite5mInputTokens-u.cacheWrite1hInputTokens),output:u.outputTokens,reasoning:u.reasoningOutputTokens},m.time===null?null:new Date(m.time).toISOString()).costUSD;
}

const stats = {roots:0, symlinkRoots:0, childSymlinks:0, auxiliaryFiles:0, files:0, mainFiles:0, subagentFiles:0, desktopFiles:0, invalidJsonLines:0, readFailures:0, unknownIdentityFiles:0, filenameMismatchFiles:0, missingMessageIds:0, missingRequestIds:0, changedDuringRead:0};
const roots = [];
for (const ent of fs.readdirSync(home, {withFileTypes:true})) if (ent.name === '.claude' || ent.name.startsWith('.claude-')) roots.push(path.join(home, ent.name, 'projects'));
roots.push(path.join(home, '.config/claude/projects'));
if (process.env.CLAUDE_CONFIG_DIR) roots.push(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects'));
roots.push(path.join(home, 'Library/Application Support/Claude/local-agent-mode-sessions'));
const realRoots = new Set(), discovered = [];
function walk(dir, root, ancestry = new Set()) {
  let real, entries;
  try { real = fs.realpathSync(dir); if (ancestry.has(real)) return; entries = fs.readdirSync(dir, {withFileTypes:true}); } catch { return; }
  const next = new Set(ancestry).add(real);
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, root, next);
    else if (e.isSymbolicLink()) {
      stats.childSymlinks++;
      try { if (fs.statSync(p).isDirectory()) walk(p, root, next); else if (/\.jsonl$/.test(e.name)) discovered.push({path:p, root}); } catch {}
    } else if (e.name.endsWith('.jsonl') || /^local_.*\.json$/.test(e.name)) discovered.push({path:p, root});
  }
}
for (const root of roots) {
  try { const real = fs.realpathSync(root); if (root !== real) stats.symlinkRoots++; if (realRoots.has(real)) continue; realRoots.add(real); stats.roots++; walk(root, hash(real)); } catch {}
}
const groups = new Map(), files = [], globalMessages = new Map();
function mergeMessage(map, msg) {
  const prev = map.get(msg.key);
  if (!prev || msg.tokens.outputTokens > prev.tokens.outputTokens || (msg.tokens.outputTokens === prev.tokens.outputTokens && msg.tokens.inputTokens > prev.tokens.inputTokens)) map.set(msg.key, msg);
}
for (const candidate of discovered.sort((a,b) => a.path.localeCompare(b.path))) {
  if (path.basename(candidate.path) === 'audit.jsonl') continue;
  const isSub = candidate.path.includes(`${path.sep}subagents${path.sep}`);
  const basename = path.basename(candidate.path).replace(/\.jsonl?$/, '').replace(/^local_/, '');
  if (!isSub && !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(basename)) { stats.auxiliaryFiles++; continue; }
  const parent = isSub ? candidate.path.split(`${path.sep}subagents${path.sep}`)[0].split(path.sep).at(-1) : basename;
  const f = {key:hash(candidate.path), root:candidate.root, contentHash:null, subagent:isSub, desktop:candidate.path.includes('/local-agent-mode-sessions/'), identity:null, cwd:null, groupId:parent, first:Infinity, last:-Infinity, records:0, messages:new Map(), requestKeys:new Set(), userIds:new Set(), mainIdentityMatches:false};
  let before;
  try {
    before = fs.statSync(candidate.path);
    const digest = createHash('sha256'), stream = fs.createReadStream(candidate.path, {encoding:'utf8'});
    stream.on('data', chunk => digest.update(chunk));
    for await (const line of lfLines(stream)) {
      if (!line.trim()) continue;
      let r; try { r=JSON.parse(line); } catch { stats.invalidJsonLines++; continue; }
      f.records++;
      if (!f.identity && typeof r.sessionId === 'string') f.identity = r.sessionId;
      if (!f.cwd && typeof r.cwd === 'string') f.cwd = r.cwd;
      if (r.sessionId === parent) f.mainIdentityMatches = true;
      const time = Date.parse(r.timestamp);
      if (Number.isFinite(time)) { f.first=Math.min(f.first,time); f.last=Math.max(f.last,time); }
      if (r.type === 'user' && r.uuid) f.userIds.add(hash(r.uuid));
      if (r.type !== 'assistant' || !r.message?.usage) continue;
      const id = r.message.id;
      if (!id) stats.missingMessageIds++;
      if (!r.requestId) stats.missingRequestIds++;
      const key = id ? hash(id) : hash(`${f.key}:${f.records}`);
      const request = r.requestId ? hash(r.requestId) : null;
      if (request) f.requestKeys.add(request);
      const model = /^[A-Za-z0-9._<>:-]{1,128}$/.test(r.message.model || '') ? r.message.model : '<unknown>';
      const msg = {key, request, model, time:Number.isFinite(time)?time:null, tokens:usage(r.message.usage), rawCacheWrite:n(r.message.usage.cache_creation_input_tokens), fileKey:f.key, subagent:isSub};
      const parts=r.message.usage.iterations;
      if(Array.isArray(parts)&&parts.length>1)msg.iterations=parts.map((part,index)=>({...msg,model:typeof part.model==='string'?part.model:msg.model,tokens:usage({...part,...(index===parts.length-1&&part.output_tokens===r.message.usage.output_tokens?{output_tokens_details:r.message.usage.output_tokens_details}:{})})}));
      mergeMessage(f.messages, msg);
    }
    f.contentHash = digest.digest('hex').slice(0,24);
    const after = fs.statSync(candidate.path);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) stats.changedDuringRead++;
  } catch { stats.readFailures++; continue; }
  stats.files++; stats[isSub?'subagentFiles':'mainFiles']++; if (f.desktop) stats.desktopFiles++;
  if (!f.identity) stats.unknownIdentityFiles++;
  if (!isSub && f.identity && f.identity !== parent) stats.filenameMismatchFiles++;
  files.push(f);
  let g=groups.get(parent);
  if (!g) { g={id:parent, sessionKey:keyFor(parent), files:[], messages:new Map(), first:Infinity, last:-Infinity, mainFiles:0}; groups.set(parent,g); }
  g.files.push(f); g.first=Math.min(g.first,f.first); g.last=Math.max(g.last,f.last); if (!isSub) g.mainFiles++;
  for (const msg of f.messages.values()) mergeMessage(g.messages,msg);
  if (stats.files % 300 === 0) console.log(JSON.stringify({progressFiles:stats.files}));
}

// Resolve legacy public-key aliases independently as a bipartite match after exact IDs.
// Require uniqueness on BOTH sides; never greedily consume an ambiguous candidate.
const legacyEdges = legacyRows.map(row=>({row,matches:[...groups.values()].filter(g=>!registrations.has(g.id) && g.files.some(f=>!f.subagent && f.identity===g.id && f.cwd===row.workspace_path && Math.abs(f.first-Date.parse(row.created_at))<=15*60_000))}));
let legacyAliases=0;
for (const edge of legacyEdges) if (edge.matches.length===1 && legacyEdges.filter(other=>other.matches.includes(edge.matches[0])).length===1) { edge.matches[0].sessionKey=hash(edge.row.id); legacyAliases++; }

function summarize(messages) {
  const tokens=empty(), byMonth={}, byModel={}, execution={topLevel:empty(), subagent:empty()}; let dollars=0, unpricedMessages=0;
  for (const response of messages) for(const m of response.iterations??[response]) {
    add(tokens,m.tokens); add(execution[m.subagent?'subagent':'topLevel'],m.tokens);
    const cost=price(m); if (cost === null) unpricedMessages++; else dollars+=cost;
    const month=m.time === null?'unknown':new Date(m.time).toISOString().slice(0,7);
    for (const [obj,key] of [[byMonth,month],[byModel,m.model]]) {
      obj[key] ||= {tokens:empty(), dollars:0, messages:0}; add(obj[key].tokens,m.tokens); obj[key].dollars+=cost||0; obj[key].messages++;
    }
  }
  return {tokens,dollars,unpricedMessages,byMonth,byModel,execution};
}
const physicalIterationCorrections=[];
const sessions=[], messageOwners=new Map(), identicalFiles=new Map(), requestMessages=new Map();
for (const f of files) { const a=identicalFiles.get(f.contentHash)||[]; a.push(f.key); identicalFiles.set(f.contentHash,a); }
for (const g of groups.values()) {
  const live=g.last>cutoff, s=refs.get(g.sessionKey), sum=summarize(g.messages.values());
  if(!live)for(const m of g.messages.values())if(m.iterations){const physical=summarize([m]);physicalIterationCorrections.push({sessionKey:g.sessionKey,messageKey:m.key,physicalRequests:m.iterations.length,aggregateTokens:m.tokens,physicalTokens:physical.tokens,deltaTokens:add({...physical.tokens},m.tokens,-1),aggregateUsd:price(m),physicalUsd:physical.dollars,deltaUsd:physical.dollars-price(m)});}

  const fileSums=g.files.map(f=>({fileKey:f.key,rootKey:f.root,contentHash:f.contentHash,subagent:f.subagent,identityMatches:f.identity===g.id,anyIdentityMatches:f.mainIdentityMatches,records:f.records,uniqueMessages:f.messages.size,...summarize(f.messages.values())}));
  sessions.push({sessionKey:g.sessionKey,providerIdentityHash:hash(g.id),referencePresent:!!s,liveAfterCutoff:live,mainFiles:g.mainFiles,files:g.files.length,roots:new Set(g.files.map(f=>f.root)).size,firstEventAt:Number.isFinite(g.first)?new Date(g.first).toISOString():null,lastEventAt:Number.isFinite(g.last)?new Date(g.last).toISOString():null,...sum,reference:s?{tokens:s.tokens,dollars:s.cost.totalUsd,files:s.transcript.files,costBasis:s.costBasis,repositoryKey:hash(s.repositoryId),spendByDay:s.spendByDay,models:s.models.map(m=>({model:m.model,calls:m.calls,inputTokens:m.inputTokens,outputTokens:m.outputTokens,totalUsd:m.totalUsd}))}:null,delta:s?{tokens:add({...sum.tokens},s.tokens,-1),dollars:sum.dollars-s.cost.totalUsd}:null,fileSums});
  if (live) continue;
  for (const m of g.messages.values()) {
    mergeMessage(globalMessages,m);
    const owners=messageOwners.get(m.key)||[]; owners.push({sessionKey:g.sessionKey,...m}); messageOwners.set(m.key,owners);
    if (m.request) { const ids=requestMessages.get(m.request)||new Set(); ids.add(m.key); requestMessages.set(m.request,ids); }
  }
}
const overlaps=[];
for (const [messageKey, owners] of messageOwners) if (owners.length>1) overlaps.push({messageKey,owners:owners.map(o=>({sessionKey:o.sessionKey,model:o.model,time:o.time,tokens:o.tokens,subagent:o.subagent,requestKey:o.request,cost:price(o)}))});
const stable=sessions.filter(s=>!s.liveAfterCutoff);
const output={oracleVersion:4,physicalIterationCorrections,source:'independent Claude LF-only raw JSONL scan; no application imports',referenceGeneratedAt:snapshot.generatedAt,stats,legacyAliases,sessionCounts:{all:groups.size,stable:stable.length,liveExcluded:sessions.length-stable.length,stableMatched:stable.filter(s=>s.referencePresent).length,stableMissing:stable.filter(s=>!s.referencePresent).length,orphanSubagentGroups:stable.filter(s=>!s.mainFiles).length,multipleMainFiles:stable.filter(s=>s.mainFiles>1).length},ttlReconciliations:[...globalMessages.values()].filter(m=>m.tokens.cacheWriteInputTokens>m.rawCacheWrite).map(m=>({messageKey:m.key,rawCacheWrite:m.rawCacheWrite,ttl5m:m.tokens.cacheWrite5mInputTokens,ttl1h:m.tokens.cacheWrite1hInputTokens,delta:m.tokens.cacheWriteInputTokens-m.rawCacheWrite})),sameContentFileGroups:[...identicalFiles.values()].filter(v=>v.length>1),requestIdsWithMultipleMessages:[...requestMessages.values()].filter(v=>v.size>1).length,globalUnique:summarize(globalMessages.values()),crossSessionMessageOverlaps:overlaps,sessions};
fs.writeFileSync('.lane/claude-oracle.json', JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({referenceGeneratedAt:output.referenceGeneratedAt,stats,sessionCounts:output.sessionCounts,sameContentFileGroups:output.sameContentFileGroups.length,crossSessionMessages:overlaps.length,requestIdsWithMultipleMessages:output.requestIdsWithMultipleMessages,tokenMismatches:stable.filter(s=>s.delta&&Object.values(s.delta.tokens).some(Boolean)).length,globalUniqueTokens:output.globalUnique.tokens},null,2));
