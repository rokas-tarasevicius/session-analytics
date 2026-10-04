// Independent raw-data inventory. No application modules are imported.
// Raw identifiers, paths, and message content are held only in memory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { DatabaseSync } from '../shared/sqlite.ts';

process.on('uncaughtException', () => { console.error('Overlap validation failed; local details suppressed.'); process.exit(1); });
process.on('unhandledRejection', () => { console.error('Overlap validation failed; local details suppressed.'); process.exit(1); });

const home = os.homedir();
const compactReference = '.lane/conductor-reference.json';
const reference = JSON.parse(fs.readFileSync(fs.existsSync(compactReference) ? compactReference
  : path.join(home, 'session-analytics-lanes/reference/snapshot-noindex-51ea561.json'), 'utf8'));
const cutoff = new Date(reference.generatedAt).toISOString();
const hash = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
const stamp = s => {
  if (!s) return null;
  const n = typeof s === 'number' ? s : Date.parse(/Z$|[+-]\d\d:\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
};
const latest = (a, b) => !a ? b : !b ? a : a > b ? a : b;
const zero = () => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
const usage = u => ({ input: Number(u?.input_tokens) || 0,
  cacheRead: Number(u?.cache_read_input_tokens) || 0,
  cacheWrite: Number(u?.cache_creation_input_tokens) || 0,
  output: Number(u?.output_tokens) || 0 });
const add = (a, b) => { for (const k of Object.keys(a)) a[k] += b[k] || 0; return a; };
const max = (a, b) => { for (const k of Object.keys(a)) a[k] = Math.max(a[k], b[k] || 0); return a; };
const db = new DatabaseSync(path.join(home, 'Library/Application Support/com.conductor.app/conductor.db'), { readOnly: true });
const sessions = db.prepare('SELECT id,agent_type,claude_session_id,created_at,updated_at FROM sessions').all();
const byId = new Map(sessions.map(s => [s.id, { ...s, messages: new Map(), transcriptMessages: new Map(),
  transcriptMatchingRecords: new Map(), transcriptFiles: new Set(), primaryTranscriptFiles: new Set(), childTranscriptFiles: new Set(),
  sdkRuns: new Map(), lastActivity: stamp(s.created_at), transcriptLast: null }]));
for (const r of db.prepare('SELECT session_id,MAX(created_at) AS last FROM session_messages GROUP BY session_id').iterate()) {
  const s = byId.get(r.session_id); if (s) s.lastActivity = latest(s.lastActivity, stamp(r.last));
}
// Project only the fields required to prove transcript coverage; SQL does not return content.
const assistantQuery = `SELECT session_id,
 json_extract(content,'$.message.id') AS message_id,
 json_extract(content,'$.uuid') AS envelope_uuid,
 json_extract(content,'$.message.usage') AS usage
 FROM session_messages WHERE role='assistant' AND json_valid(content)
 AND json_extract(content,'$.type')='assistant'`;
let sdkAssistantRows = 0, sdkAssistantRowsWithoutId = 0;
for (const r of db.prepare(assistantQuery).iterate()) {
  sdkAssistantRows++;
  const s = byId.get(r.session_id); if (!s) continue;
  if (!r.message_id) sdkAssistantRowsWithoutId++;
  const identity = r.message_id ? `id:${r.message_id}` : r.envelope_uuid ? `uuid:${r.envelope_uuid}` : null;
  if (!identity) continue;
  let u = {}; try { u = JSON.parse(r.usage || '{}'); } catch {}
  s.messages.set(identity, max(s.messages.get(identity) || zero(), usage(u)));
}
db.close();
console.log('Raw Conductor assistant identity projection complete.');

const byProviderId = new Map();
for (const s of byId.values()) for (const id of new Set([s.id, s.claude_session_id].filter(Boolean))) {
  byProviderId.set(`${s.agent_type}:${id}`, s);
}
const seenFiles = new Set();
const discovered = { claude: 0, codex: 0, cursor: 0, cursorSdk: 0 };
const parseErrors = { claude: 0, codex: 0, cursor: 0, cursorSdk: 0 };
async function* walk(dir) {
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}
async function records(file, kind, fn) {
  try {
    for await (const line of readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })) {
      if (!line.trim()) continue;
      let x; try { x = JSON.parse(line); } catch { parseErrors[kind]++; continue; }
      fn(x);
    }
  } catch { parseErrors[kind]++; }
}
async function scanTranscripts(dir, kind) {
  for await (const file of walk(dir)) {
    if (!file.endsWith('.jsonl')) continue;
    const canonical = fs.realpathSync(file);
    if (seenFiles.has(canonical)) continue;
    seenFiles.add(canonical); discovered[kind]++;
    const base = path.basename(file, '.jsonl');
    const id = kind === 'codex' ? base.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i)?.[1] : base;
    let s = byProviderId.get(`${kind}:${id}`), child = false;
    if (!s && kind === 'claude') {
      const directories = path.dirname(file).split(path.sep), childIndex = directories.lastIndexOf('subagents');
      if (childIndex > 0) { s = byProviderId.get(`claude:${directories[childIndex - 1]}`); child = Boolean(s); }
    }
    if (!s) continue;
    s.transcriptFiles.add(canonical);
    (child ? s.childTranscriptFiles : s.primaryTranscriptFiles).add(canonical);
    await records(file, kind, x => {
      s.transcriptLast = latest(s.transcriptLast, stamp(x.timestamp));
      if (kind === 'claude' && x.type === 'assistant' && x.message?.id) {
        s.transcriptMessages.set(x.message.id, max(s.transcriptMessages.get(x.message.id) || zero(), usage(x.message.usage)));
      }
      if (kind === 'claude' && x.type === 'assistant') {
        for (const id of [x.message?.id ? `id:${x.message.id}` : null, x.uuid ? `uuid:${x.uuid}` : null].filter(Boolean)) {
          s.transcriptMatchingRecords.set(id, max(s.transcriptMatchingRecords.get(id) || zero(), usage(x.message?.usage)));
        }
      }
    });
  }
}
for (const entry of fs.readdirSync(home, { withFileTypes: true })) {
  if (entry.name.startsWith('.claude')) await scanTranscripts(path.join(home, entry.name, 'projects'), 'claude');
  if (entry.name.startsWith('.codex')) {
    await scanTranscripts(path.join(home, entry.name, 'sessions'), 'codex');
    await scanTranscripts(path.join(home, entry.name, 'archived_sessions'), 'codex');
  }
}
await scanTranscripts(path.join(home, '.cursor/projects'), 'cursor');
for await (const file of walk(path.join(home, 'Library/Application Support/com.conductor.app/cursor-sdk-store'))) {
  if (path.basename(file) !== 'runs.ndjson') continue;
  discovered.cursorSdk++;
  await records(file, 'cursorSdk', r => {
    const s = byProviderId.get(`cursor:${r.agentId}`); if (!s) return;
    s.transcriptFiles.add(file);
    s.primaryTranscriptFiles.add(file);
    s.transcriptLast = latest(s.transcriptLast, stamp(r.endedAt || r.updatedAt || r.startedAt || r.createdAt));
    if (r.runId) s.sdkRuns.set(r.runId, { input: Number(r.usage?.inputTokens) || 0,
      cacheRead: Number(r.usage?.cacheReadTokens) || 0, cacheWrite: Number(r.usage?.cacheWriteTokens) || 0,
      output: Number(r.usage?.outputTokens) || 0 });
  });
}

const refByKey = new Map();
for (const s of reference.sessions) {
  const arr = refByKey.get(s.sessionKey) || []; arr.push(s); refByKey.set(s.sessionKey, arr);
}
const rows = [];
for (const s of byId.values()) {
  const key = hash(s.id);
  const direct = refByKey.get(key) || [];
  const nativeKeys = new Set([s.id, s.claude_session_id].filter(Boolean).map(id=>hash(`${s.agent_type}:${id}`)));
  const native = [...nativeKeys].filter(k=>k!==key).flatMap(k=>refByKey.get(k)||[]);
  const cursorSdkKey = s.claude_session_id && s.agent_type === 'cursor' ? hash(`cursor-sdk:${s.claude_session_id}`) : null;
  const cursorSdk = cursorSdkKey ? refByKey.get(cursorSdkKey) || [] : [];
  const missingTokens = zero(), intersectTokens = zero();
  let matched = 0, missing = 0;
  for (const [id, u] of s.messages) {
    if (s.transcriptMatchingRecords.has(id)) { matched++; add(intersectTokens, u); }
    else { missing++; add(missingTokens, u); }
  }
  const sdkTokens = zero(); for (const u of s.sdkRuns.values()) add(sdkTokens, u);
  const activeAfterCutoff = (latest(s.lastActivity, s.transcriptLast) || '') > cutoff;
  const ref = direct[0] || native[0] || cursorSdk[0];
  let evidence = 'absent';
  if (s.transcriptFiles.size) evidence = s.agent_type !== 'claude' ? 'present-completeness-unproven'
    : !s.messages.size ? 'present-no-sdk-assistant-baseline' : missing ? 'partial-sdk-assistant-coverage' : 'all-sdk-assistant-ids-present';
  rows.push({ sessionKey: key, provider: s.agent_type, month: stamp(s.created_at)?.slice(0,7) || null,
    activeAfterCutoff, providerIdRegistered: Boolean(s.claude_session_id),
    primaryTranscriptFiles: s.primaryTranscriptFiles.size, childTranscriptFiles: s.childTranscriptFiles.size,
    transcriptFiles: s.transcriptFiles.size, transcriptEvidence: evidence,
    sdkAssistantMessages: s.messages.size, transcriptAssistantMessages: s.transcriptMessages.size,
    assistantIdIntersection: matched, sdkAssistantIdsAbsentFromTranscript: missing,
    sdkAssistantTokensAbsentFromTranscript: missingTokens, sdkAssistantTokensInTranscript: intersectTokens,
    cursorSdkRuns: s.sdkRuns.size, cursorSdkTokens: sdkTokens,
    referenceConductorKeyCount: direct.length, referenceNativeKeyCount: native.length,
    referenceCursorSdkKeyCount: cursorSdk.length,
    referenceMatchedSessionKey: ref?.sessionKey || null,
    referenceKeyScheme: direct.length ? 'conductor' : native.length ? 'provider' : cursorSdk.length ? 'cursor-sdk' : 'absent',
    referenceProvider: ref?.provider || null, referenceTranscriptStatus: ref?.transcript?.status || null,
    referenceCompleteness: ref?.transcript?.completeness || null,
    referenceFiles: ref?.transcript?.files ?? null,
    referenceCostBasis: ref?.costBasis || null,
    referenceSource: ref ? ref.source || ref.evidence?.source || 'native' : null,
    referenceCostUsd: ref?.cost?.totalUsd ?? 0,
    referenceTokens: ref?.tokens || null });
}
function aggregate(rows, getKey) {
  const m = new Map();
  for (const s of rows) {
    const key = getKey(s);
    const v = m.get(key) || { key, registered: 0, inReference: 0, absentReference: 0, transcriptPresent: 0,
      transcriptAbsent: 0, partialSdkAssistantCoverage: 0, duplicateKeys: 0, referenceCostUsd: 0,
      sdkAssistantTokensAbsentFromTranscript: zero() };
    v.registered++; v.inReference += Number(Boolean(s.referenceMatchedSessionKey));
    v.absentReference += Number(!s.referenceMatchedSessionKey);
    v.transcriptPresent += Number(s.transcriptFiles > 0); v.transcriptAbsent += Number(!s.transcriptFiles);
    v.partialSdkAssistantCoverage += Number(s.transcriptEvidence === 'partial-sdk-assistant-coverage');
    v.duplicateKeys += Number(s.referenceConductorKeyCount + s.referenceNativeKeyCount + s.referenceCursorSdkKeyCount > 1);
    v.referenceCostUsd += s.referenceCostUsd;
    if (s.transcriptFiles) add(v.sdkAssistantTokensAbsentFromTranscript, s.sdkAssistantTokensAbsentFromTranscript);
    m.set(key, v);
  }
  return [...m.values()].sort((a,b) => a.key.localeCompare(b.key));
}
const eligible = rows.filter(s => !s.activeAfterCutoff);
const out = { version: 1, referenceCutoff: cutoff, registeredSessions: rows.length,
  assistantIdentityRule: 'message-id-else-envelope-uuid',
  sdkUsageTotalsInterpretation: 'raw-evidence-record-sums-not-request-accounting',
  excludedActiveAfterCutoff: rows.length - eligible.length, sdkAssistantRows, sdkAssistantRowsWithoutId,
  discovered, parseErrors,
  referenceDuplicateSessionKeys: [...refByKey].filter(([,v])=>v.length>1).map(([sessionKey,v])=>({sessionKey,count:v.length})),
  providerAggregates: aggregate(eligible, s=>s.provider), monthlyAggregates: aggregate(eligible, s=>`${s.month}:${s.provider}`),
  sessions: rows };
fs.mkdirSync('.lane', { recursive: true });
fs.writeFileSync('.lane/conductor-overlap.json', JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify({ registeredSessions: out.registeredSessions, excludedActiveAfterCutoff: out.excludedActiveAfterCutoff,
  providerAggregates: out.providerAggregates, parseErrors: out.parseErrors }, null, 2));
