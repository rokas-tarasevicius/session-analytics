/** Independent raw-store inventory. No analyzer imports; raw identities/paths stay in memory. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { lfLines } from '../shared/lf-lines.mjs';
import { DatabaseSync } from '../shared/sqlite.ts';
import { fileURLToPath } from 'node:url';

export const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
const UUID = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i;
export function discoverRoots(home = os.homedir()) {
  const candidates = fs.readdirSync(home, { withFileTypes: true })
    .filter(e => e.name === '.claude' || e.name.startsWith('.claude-'))
    .map(e => ({ path: path.join(home, e.name, 'projects'), kind: 'code' }));
  candidates.push({ path: path.join(home, '.config/claude/projects'), kind: 'code' });
  if (process.env.CLAUDE_CONFIG_DIR) candidates.push({ path: path.join(process.env.CLAUDE_CONFIG_DIR, 'projects'), kind: 'code' });
  for (const dir of ['local-agent-mode-sessions', 'claude-code-sessions']) {
    candidates.push({ path: path.join(home, 'Library/Application Support/Claude', dir), kind: dir });
  }
  const roots = new Map();
  for (const candidate of candidates) {
    try { const resolved = fs.realpathSync(candidate.path); if (fs.statSync(resolved).isDirectory()) roots.set(resolved, { ...candidate, path: resolved, profileKey: hash(`profile:${resolved}`) }); } catch {}
  }
  return [...roots.values()];
}
export function discoverFiles(roots = discoverRoots()) {
  const files = [];
  for (const root of roots) {
    const walk = dir => {
      let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && /\.jsonl?$/.test(entry.name)) {
          const relative = path.relative(root.path, full);
          const isSubagent = relative.split(path.sep).includes('subagents');
          const ancestorIds = relative.split(path.sep).slice(0, -1).map(x => x.match(UUID)?.[0]).filter(Boolean);
          files.push({ path: full, profileKey: root.profileKey, kind: root.kind, isSubagent,
            filenameId: entry.name.match(UUID)?.[0] ?? null,
            parentId: isSubagent ? ancestorIds.at(-1) ?? null : null,
            extension: path.extname(full), audit: entry.name === 'audit.jsonl' });
        }
      }
    };
    walk(root.path);
  }
  return files;
}
export function conductorRows(home = os.homedir()) {
  const db = new DatabaseSync(path.join(home, 'Library/Application Support/com.conductor.app/conductor.db'), { readOnly: true });
  try { return db.prepare('SELECT s.id, s.claude_session_id, s.agent_type, s.created_at, s.updated_at, w.workspace_path FROM sessions s LEFT JOIN workspaces w ON w.id=s.workspace_id').all(); }
  finally { db.close(); }
}

export async function audit() {
  const roots = discoverRoots(); const files = discoverFiles(roots);
  const snapshot = JSON.parse(fs.readFileSync(path.join(os.homedir(), 'session-analytics-lanes/reference/snapshot-noindex-51ea561.json'), 'utf8'));
  const cutoff = Date.parse(snapshot.generatedAt);
  const references = new Map(snapshot.sessions.filter(s => s.provider === 'claude').map(s => [s.sessionKey, s]));
  const rows = conductorRows().filter(x => x.agent_type === 'claude');
  const byProvider = new Map();
  for (const row of rows) if (row.claude_session_id) { const list = byProvider.get(row.claude_session_id) ?? []; list.push(row); byProvider.set(row.claude_session_id, list); }
  const profiles = new Map(roots.map(root => [root.profileKey, { profileKey: root.profileKey, sourceKind: root.kind, files: 0, jsonlFiles: 0, jsonFiles: 0, subagentFiles: 0, auditFiles: 0, malformedLines: 0, mainIdentityFiles: 0, mismatchedIdentityFiles: 0, usageFiles: 0, postCutoffFiles: 0, emptyFiles: 0, nonSessionFiles: 0 }]));
  const sessions = new Map(); const recordsByType = new Map(); const identitylessTypes = new Map(); const sourceShapes = new Map();
  for (const file of files) {
    const profile = profiles.get(file.profileKey); profile.files++; profile[file.extension === '.jsonl' ? 'jsonlFiles' : 'jsonFiles']++;
    if (file.isSubagent) profile.subagentFiles++; if (file.audit) profile.auditFiles++;
    const ids = new Set(); let count = 0; let usageRecords = 0; let earliest = Infinity; let latest = -Infinity; let hasCwd = false; let cwd = null; const types = new Map(); const shape = new Set();
    const consume = record => {
      count++; if (!record || typeof record !== 'object' || Array.isArray(record)) return;
      for (const key of Object.keys(record)) shape.add(key);
      if (typeof record.sessionId === 'string') ids.add(record.sessionId);
      if (typeof record.cwd === 'string' && record.cwd) { hasCwd = true; cwd ??= record.cwd; }
      const ts = Date.parse(record.timestamp); if (Number.isFinite(ts)) { earliest = Math.min(earliest, ts); latest = Math.max(latest, ts); }
      const type = typeof record.type === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(record.type) ? record.type : '<unknown>';
      types.set(type, (types.get(type) ?? 0) + 1); recordsByType.set(type, (recordsByType.get(type) ?? 0) + 1);
      if (record.type === 'assistant' && record.message?.usage) usageRecords++;
    };
    if (file.extension === '.json') {
      try { consume(JSON.parse(fs.readFileSync(file.path, 'utf8'))); } catch { profile.malformedLines++; }
    } else {
      for await (const line of lfLines(fs.createReadStream(file.path))) {
        if (!line.trim()) continue; try { consume(JSON.parse(line)); } catch { profile.malformedLines++; }
      }
    }
    if (usageRecords) profile.usageFiles++; if (!count) profile.emptyFiles++; if (latest > cutoff) profile.postCutoffFiles++;
    const sourceShape = sourceShapes.get(`${file.kind}:${file.extension}`) ?? new Set(); for (const key of shape) sourceShape.add(key); sourceShapes.set(`${file.kind}:${file.extension}`, sourceShape);
    const matched = file.filenameId && ids.has(file.filenameId);
    if (!file.isSubagent && matched && hasCwd) profile.mainIdentityFiles++;
    else if (!file.isSubagent && ids.size && file.filenameId) profile.mismatchedIdentityFiles++;
    else if (!file.isSubagent) { profile.nonSessionFiles++; for (const [type, n] of types) identitylessTypes.set(type, (identitylessTypes.get(type) ?? 0) + n); }
    const providerId = file.isSubagent && file.extension === '.jsonl' ? file.parentId : !file.isSubagent && matched && hasCwd ? file.filenameId : null;
    if (!providerId || file.audit) continue;
    let item = sessions.get(providerId);
    if (!item) { item = { providerId, cwd, files: 0, mainFiles: 0, subagentFiles: 0, profileKeys: new Set(), kinds: new Set(), usageRecords: 0, postCutoff: false, firstEventAt: null, lastEventAt: null }; sessions.set(providerId, item); }
    if (!file.isSubagent) item.cwd = cwd;
    item.files++; item[file.isSubagent ? 'subagentFiles' : 'mainFiles']++; item.profileKeys.add(file.profileKey); item.kinds.add(file.kind); item.usageRecords += usageRecords; item.postCutoff ||= latest > cutoff;
    if (Number.isFinite(earliest) && (!item.firstEventAt || earliest < Date.parse(item.firstEventAt))) item.firstEventAt = new Date(earliest).toISOString();
    if (Number.isFinite(latest) && (!item.lastEventAt || latest > Date.parse(item.lastEventAt))) item.lastEventAt = new Date(latest).toISOString();
  }
  const keysWithRaw = new Set(); const exported = [];
  for (const item of sessions.values()) {
    let registrations = byProvider.get(item.providerId) ?? [];
    let legacyCorrelation = false;
    if (!registrations.length && item.cwd && item.firstEventAt) {
      const legacyMatches = rows.filter(r => !r.claude_session_id && r.workspace_path === item.cwd && Math.abs(Date.parse(r.created_at) - Date.parse(item.firstEventAt)) <= 15 * 60_000);
      if (legacyMatches.length === 1) {
        const legacy = legacyMatches[0];
        const nativeMatches = [...sessions.values()].filter(s => !byProvider.has(s.providerId) && s.mainFiles && s.cwd === legacy.workspace_path && s.firstEventAt && Math.abs(Date.parse(legacy.created_at) - Date.parse(s.firstEventAt)) <= 15 * 60_000);
        if (nativeMatches.length === 1) { registrations = legacyMatches; legacyCorrelation = true; }
      }
    }
    const registeredKeys = registrations.map(r => hash(r.id)); const directKey = hash(`claude:${item.providerId}`);
    for (const key of [...registeredKeys, directKey]) keysWithRaw.add(key);
    const matches = [...registeredKeys, directKey].filter(key => references.has(key));
    exported.push({ sessionKey: registeredKeys[0] ?? directKey, directKey, registeredKeys, legacyCorrelation, referenceKeys: matches, files: item.files, mainFiles: item.mainFiles, subagentFiles: item.subagentFiles, profileKeys: [...item.profileKeys], sourceKinds: [...item.kinds], usageRecords: item.usageRecords, postCutoff: item.postCutoff, firstEventAt: item.firstEventAt, lastEventAt: item.lastEventAt });
  }
  const result = { generatedAt: new Date().toISOString(), referenceGeneratedAt: snapshot.generatedAt, profiles: [...profiles.values()], recordsByType: Object.fromEntries(recordsByType), identitylessRecordsByType: Object.fromEntries(identitylessTypes), sourceShapes: Object.fromEntries([...sourceShapes].map(([k, v]) => [k, [...v].sort()])), counts: { sourceFiles: files.length, rawLogicalSessions: exported.length, rawMainSessions: exported.filter(x => x.mainFiles).length, orphanSubagentSessions: exported.filter(x => !x.mainFiles).length, referenceClaudeSessions: references.size, rawStableMatched: exported.filter(x => !x.postCutoff && x.referenceKeys.length).length, rawStableMissing: exported.filter(x => !x.postCutoff && !x.referenceKeys.length).length, rawPostCutoff: exported.filter(x => x.postCutoff).length, crossProfileIdentities: exported.filter(x => x.profileKeys.length > 1).length, multipleRegistrations: [...byProvider.values()].filter(x => x.length > 1).length }, sessions: exported, referenceWithoutNative: [...references.values()].filter(x => !keysWithRaw.has(x.sessionKey)).map(s => ({ sessionKey: s.sessionKey, tokens: s.tokens, cost: s.cost.totalUsd, transcriptStatus: s.transcript.status, models: s.models.map(m => m.model) })) };
  const absent = [...references.values()].filter(s => !keysWithRaw.has(s.sessionKey));
  const aggregate = list => list.reduce((a, s) => {
    a.sessions++; a.costUsd += s.cost.totalUsd;
    for (const [key, value] of Object.entries(s.tokens)) a.tokens[key] = (a.tokens[key] ?? 0) + value;
    return a;
  }, { sessions: 0, costUsd: 0, tokens: {} });
  result.recoveryOnlyAggregate = aggregate(absent);
  const monthOf = s => (s.firstEventAt ?? s.createdAt ?? 'unknown').slice(0, 7);
  result.recoveryOnlyByMonth = Object.fromEntries([...new Set(absent.map(monthOf))].sort().map(month => [month, aggregate(absent.filter(s => monthOf(s) === month))]));
  result.recoveryEvidenceCounts = {};
  for (const s of absent) {
    const source = s.evidence?.source === 'conductor-result' ? 'conductor-result' : 'other';
    result.recoveryEvidenceCounts[source] = (result.recoveryEvidenceCounts[source] ?? 0) + 1;
  }
  fs.writeFileSync('.lane/claude-key-aliases.json', JSON.stringify(Object.fromEntries(exported.filter(s => s.legacyCorrelation).map(s => [s.directKey, s.sessionKey])), null, 2) + '\n');
  fs.writeFileSync('.lane/claude-discovery-audit.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ counts: result.counts, profiles: result.profiles, referenceWithoutNative: result.referenceWithoutNative.length }));
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await audit(); } catch { console.error('Claude discovery audit failed; private error details suppressed.'); process.exitCode = 1; }
}
