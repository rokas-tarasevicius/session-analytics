// Independent legacy registration check. Only hashed keys and counters are emitted.
// Provider IDs and working directories are used privately for local correlation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { DatabaseSync } from '../shared/sqlite.ts';

process.on('uncaughtException', () => { console.error('Legacy Codex validation failed; local details suppressed.'); process.exit(1); });
process.on('unhandledRejection', () => { console.error('Legacy Codex validation failed; local details suppressed.'); process.exit(1); });
const home = os.homedir();
const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
const timestamp = value => {
  if (typeof value !== 'string' || !value) return null;
  const normalized = /Z$|[+-]\d\d:\d\d$/.test(value) ? value : value.replace(' ', 'T') + 'Z';
  const n = Date.parse(normalized); return Number.isFinite(n) ? n : null;
};
const compactReference = '.lane/conductor-reference.json';
const reference = JSON.parse(fs.readFileSync(fs.existsSync(compactReference) ? compactReference
  : path.join(home, 'session-analytics-lanes/reference/snapshot-noindex-51ea561.json'), 'utf8'));
const referenceKeys = new Set(reference.sessions.map(s => s.sessionKey));
const cutoff = Date.parse(reference.generatedAt);
const db = new DatabaseSync(path.join(home, 'Library/Application Support/com.conductor.app/conductor.db'), { readOnly: true });
const rows = db.prepare(`SELECT s.id,s.created_at,w.workspace_path,s.claude_session_id
  FROM sessions s LEFT JOIN workspaces w ON w.id=s.workspace_id WHERE s.agent_type='codex'`).all();
db.close();
const claimed = new Set(rows.map(s => s.claude_session_id).filter(Boolean));
function* walk(directory) {
  let entries; try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(filename);
    else if (entry.isFile() && filename.endsWith('.jsonl')) yield filename;
  }
}
async function firstRecord(filename) {
  const stream = fs.createReadStream(filename);
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try { for await (const line of lines) { try { return JSON.parse(line); } catch { return null; } } }
  catch { return null; }
  finally { lines.close(); stream.destroy(); }
  return null;
}
const seen = new Set(), candidates = [];
for (const profile of fs.readdirSync(home).filter(name => name.startsWith('.codex'))) {
  for (const store of ['sessions', 'archived_sessions']) for (const filename of walk(path.join(home, profile, store))) {
    const canonical = fs.realpathSync(filename); if (seen.has(canonical)) continue; seen.add(canonical);
    const record = await firstRecord(filename), meta = record?.payload;
    if (record?.type !== 'session_meta' || typeof meta?.cwd !== 'string' || claimed.has(meta.id)) continue;
    const at = timestamp(meta.timestamp || record.timestamp);
    if (at === null || at > cutoff) continue;
    candidates.push({ cwd: path.resolve(meta.cwd), at });
  }
}
const output = [];
for (const row of rows) {
  if (row.claude_session_id) continue;
  const at = timestamp(row.created_at); if (at !== null && at > cutoff) continue;
  const matches = typeof row.workspace_path === 'string' && at !== null
    ? candidates.filter(c => c.cwd === path.resolve(row.workspace_path) && Math.abs(c.at - at) <= 15 * 60_000).length : 0;
  output.push({ sessionKey: hash(row.id), workspaceAvailable: Boolean(row.workspace_path),
    uniqueTimestampPathMatches: matches, inReference: referenceKeys.has(hash(row.id)) });
}
fs.mkdirSync('.lane', { recursive: true });
fs.writeFileSync('.lane/conductor-codex-legacy.json', JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify({ legacyRows: output.length,
  uniqueMatches: output.filter(s => s.uniqueTimestampPathMatches === 1).length,
  unmatched: output.filter(s => s.uniqueTimestampPathMatches === 0).length,
  referenceDisagreements: output.filter(s => (s.uniqueTimestampPathMatches === 1) !== s.inReference).length,
  referenceCutoff: new Date(cutoff).toISOString() }));
