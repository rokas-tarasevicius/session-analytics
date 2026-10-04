#!/usr/bin/env node
// Independent SQLite oracle. No application modules are imported.
// Raw identifiers/paths remain in memory. Every persistent identifier is hashed.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from '../shared/sqlite.ts';

const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 12);
const args = process.argv.slice(2);
const get = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const reference = get('--reference', join(homedir(), 'session-analytics-lanes/reference/snapshot-noindex-51ea561.json'));
const output = resolve(get('--output', '.lane'));
const snapshot = JSON.parse(readFileSync(reference, 'utf8'));
const cutoff = Date.parse(snapshot.generatedAt);
const sessions = new Map(snapshot.sessions.filter(row => row.provider === 'codex').map(row => [row.sessionKey, row]));
const sq = (file, sql) => {
  const database = new DatabaseSync(file, { readOnly: true });
  try { return database.prepare(sql).all(); }
  finally { database.close(); }
};
const homes = new Set();
for (const name of readdirSync(homedir()).filter(name => /^\.codex(?:-|$)/.test(name))) {
  try { const root = realpathSync(join(homedir(), name)); if (statSync(root).isDirectory()) homes.add(root); } catch {}
}
if (process.env.CODEX_HOME) { try { homes.add(realpathSync(process.env.CODEX_HOME)); } catch {} }

const registrations = new Map();
const conductor = join(homedir(), 'Library/Application Support/com.conductor.app/conductor.db');
let conductorRows = 0;
if (existsSync(conductor)) {
  for (const row of sq(conductor, "SELECT id, claude_session_id FROM sessions WHERE agent_type='codex' AND claude_session_id IS NOT NULL")) {
    conductorRows++;
    const keys = registrations.get(row.claude_session_id) || new Set();
    keys.add(hash(row.id)); registrations.set(row.claude_session_id, keys);
  }
}
const records = new Map();
const recoveryFile = join(output, 'codex-legacy-key-map.json');
const recovery = existsSync(recoveryFile) ? JSON.parse(readFileSync(recoveryFile, 'utf8')).matches : [];
const recoveredKeys = new Map(recovery.map(row => [row.threadKey, row.sessionKey]));
const databases = [];
let duplicateThreadRows = 0;
const turns = new Map();
const turnTotals = { count: 0, durationMilliseconds: 0, statuses: {}, afterCutoff: 0, missingStartedAt: 0, missingCompletedAt: 0, missingDuration: 0 };
for (const home of homes) {
  for (const name of readdirSync(home).filter(name => /^(state|thread_history)_\d+\.sqlite$/.test(name))) {
    const file = realpathSync(join(home, name));
    if (databases.some(db => db.key === hash(`database:${file}`))) continue;
    const metadata = { key: hash(`database:${file}`), kind: name.startsWith('state_') ? 'state' : 'thread_history', walBytes: existsSync(`${file}-wal`) ? statSync(`${file}-wal`).size : 0 };
    databases.push(metadata);
    if (metadata.kind === 'state') {
      const cols = new Set(sq(file, 'PRAGMA table_info(threads)').map(row => row.name));
      const fields = ['id', 'rollout_path', 'created_at', 'updated_at', 'tokens_used', 'archived', 'model', 'source', 'created_at_ms', 'updated_at_ms'].filter(name => cols.has(name));
      for (const row of sq(file, `SELECT ${fields.join(',')} FROM threads`)) {
        const existing = records.get(row.id);
        if (existing) duplicateThreadRows++;
        if (!existing || (row.updated_at_ms || row.updated_at * 1000) >= (existing.updated_at_ms || existing.updated_at * 1000)) records.set(row.id, row);
      }
    } else {
      for (const row of sq(file, 'SELECT thread_id, status, 1 AS count, coalesce(duration_ms,0) AS duration_ms, coalesce(completed_at,started_at,0) AS latest_at, started_at IS NULL AS missing_started, completed_at IS NULL AS missing_completed, duration_ms IS NULL AS missing_duration FROM thread_turns')) {
        const key = hash(`codex:${row.thread_id}`);
        const entry = turns.get(key) || { count: 0, durationMilliseconds: 0, statuses: {}, latestAt: null };
        entry.count += row.count; entry.durationMilliseconds += row.duration_ms;
        entry.statuses[row.status] = (entry.statuses[row.status] || 0) + row.count;
        // Persist only documented status enums; unexpected strings are counted under unknown.
        const state = ['completed', 'failed', 'interrupted', 'inProgress'].includes(row.status) ? row.status : 'unknown';
        turnTotals.statuses[state] = (turnTotals.statuses[state] || 0) + row.count;
        turnTotals.count += row.count; turnTotals.durationMilliseconds += row.duration_ms;
        turnTotals.missingStartedAt += row.missing_started; turnTotals.missingCompletedAt += row.missing_completed; turnTotals.missingDuration += row.missing_duration;
        const instant = row.latest_at > 1e12 ? row.latest_at : row.latest_at * 1000;
        if (instant > cutoff) turnTotals.afterCutoff += row.count;
        if (!entry.latestAt || instant > Date.parse(entry.latestAt)) entry.latestAt = instant > 0 ? new Date(instant).toISOString() : null;
        if (state !== row.status) { entry.statuses.unknown = (entry.statuses.unknown || 0) + entry.statuses[row.status]; delete entry.statuses[row.status]; }
        turns.set(key, entry);
      }
    }
  }
}

const summary = {
  threads: records.size, conductorRows, duplicateThreadRows, legacyRecovered: 0,
  matchedSnapshot: 0, missingSnapshot: 0, ambiguousSnapshotKeys: 0, afterCutoff: 0,
  tokensUsed: 0, stableMatchedTokensUsed: 0, stableMatchedSnapshotTokens: 0,
  stableMatchedSnapshotUsd: 0, stableExactTokenMatches: 0, stableOverSnapshot: 0, stableUnderSnapshot: 0,
};
const rows = [];
const keyMap = Object.fromEntries([...registrations.entries()].flatMap(([id, keys]) => {
  const matches = [...keys].filter(key => sessions.has(key));
  return matches.length === 1 ? [[hash(`codex:${id}`), matches[0]]] : [];
}));
for (const [threadKey, sessionKey] of recoveredKeys) if (sessions.has(sessionKey)) keyMap[threadKey] = sessionKey;
const monthGroups = new Map();
const modelGroups = new Map();
const repoGroups = new Map();
for (const raw of records.values()) {
  const threadKey = hash(`codex:${raw.id}`);
  const candidates = [threadKey, ...(registrations.get(raw.id) || []), recoveredKeys.get(threadKey)].filter(key => sessions.has(key));
  const unique = [...new Set(candidates)];
  const sessionKey = unique.length === 1 ? unique[0] : null;
  if (unique.length > 1) summary.ambiguousSnapshotKeys++;
  if (sessionKey) keyMap[threadKey] = sessionKey;
  const session = sessionKey ? sessions.get(sessionKey) : null;
  if (sessionKey && recoveredKeys.get(threadKey) === sessionKey) summary.legacyRecovered++;
  const updatedAt = raw.updated_at_ms || raw.updated_at * 1000;
  const createdAt = raw.created_at_ms || raw.created_at * 1000;
  const afterCutoff = updatedAt > cutoff || (!!session?.lastEventAt && Date.parse(session.lastEventAt) > cutoff);
  summary.afterCutoff += Number(afterCutoff);
  summary.tokensUsed += raw.tokens_used;
  if (session) summary.matchedSnapshot++; else summary.missingSnapshot++;
  const snapshotTokens = session ? session.tokens.inputTokens + session.tokens.outputTokens : null;
  const row = {
    threadKey, sessionKey, tokensUsed: raw.tokens_used,
    rolloutEvidenceKey: typeof raw.rollout_path === 'string' ? hash(raw.rollout_path) : null,
    createdAt: new Date(createdAt).toISOString(), updatedAt: new Date(updatedAt).toISOString(),
    archived: Boolean(raw.archived), model: raw.model || null, afterCutoff,
    snapshotTokens, snapshotUsd: session?.cost.totalUsd ?? null,
    differenceFromSnapshot: snapshotTokens === null ? null : raw.tokens_used - snapshotTokens,
    turns: turns.get(threadKey) || null,
  };
  rows.push(row);
  if (!session || afterCutoff) continue;
  summary.stableMatchedTokensUsed += raw.tokens_used;
  summary.stableMatchedSnapshotTokens += snapshotTokens;
  summary.stableMatchedSnapshotUsd += session.cost.totalUsd;
  if (raw.tokens_used === snapshotTokens) summary.stableExactTokenMatches++;
  else if (raw.tokens_used > snapshotTokens) summary.stableOverSnapshot++;
  else summary.stableUnderSnapshot++;
  for (const [groups, key] of [[monthGroups, new Date(createdAt).toISOString().slice(0, 7)], [modelGroups, raw.model || 'unknown'], [repoGroups, /^[a-f\d]+$/i.test(session.repositoryId) ? session.repositoryId : hash(`repository:${session.repositoryId}`)]]) {
    const entry = groups.get(key) || { key, threads: 0, tokensUsed: 0, snapshotTokens: 0, snapshotUsd: 0 };
    entry.threads++; entry.tokensUsed += raw.tokens_used; entry.snapshotTokens += snapshotTokens; entry.snapshotUsd += session.cost.totalUsd;
    groups.set(key, entry);
  }
}
summary.snapshotThreadsWithoutDatabaseMatch = sessions.size - new Set(rows.map(row => row.sessionKey).filter(Boolean)).size;
mkdirSync(output, { recursive: true });
const report = {
  generatedAt: new Date().toISOString(), referenceGeneratedAt: snapshot.generatedAt,
  method: 'WAL-aware read-only SQLite; guarded immutable mode only without WAL/journal and with generation proof; tokens_used is a counter to validate, not assumed independently billable usage',
  databases, summary, turnTotals,
  byCreationMonth: [...monthGroups.values()].sort((a,b)=>a.key.localeCompare(b.key)),
  byDatabaseModel: [...modelGroups.values()].sort((a,b)=>a.key.localeCompare(b.key)),
  byRepositoryKey: [...repoGroups.values()].sort((a,b)=>a.key.localeCompare(b.key)),
  threads: rows.sort((a,b)=>a.threadKey.localeCompare(b.threadKey)),
};
writeFileSync(join(output, 'codex-db-oracle.json'), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(join(output, 'codex-key-map.json'), `${JSON.stringify(keyMap, null, 2)}\n`);
console.log(JSON.stringify({ summary, databases, turnTotals }, null, 2));
