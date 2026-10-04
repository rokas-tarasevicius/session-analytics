/** Independent raw Cursor attribution reader. Never serialize returned private records. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from '../shared/sqlite.ts';

export interface CursorRecord {
  provider: 'cursor'; id: string; cwd?: string; repoHints?: string[];
  firstAt?: string; lastAt?: string; source: string;
  sources?: string[]; attributionEvidence: string; candidates?: string[];
  fileMtime?: string; isDraft?: boolean; models?: string[];
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number };
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0,12);
const directoryEntries = (p: string) => { try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; } };
const readJson = (p: string): any => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return undefined; } };
const readRows = (p: string): any[] => { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); } catch { return []; } };
const iso = (v: unknown): string | undefined => { if (typeof v !== 'number' && typeof v !== 'string') return undefined; const d = new Date(v); return Number.isFinite(d.getTime()) ? d.toISOString() : undefined; };
const uriPath = (v: unknown): string | undefined => { if (typeof v !== 'string') return undefined; try { return v.startsWith('file:') ? fileURLToPath(v) : path.isAbsolute(v) ? v : undefined; } catch { return undefined; } };
const encodePath = (p: string) => p.replace(/[^A-Za-z0-9]/g, '-').replace(/^-+/, '');

/** Decode only when an existing directory has exactly the encoded name. Multiple matches remain ambiguous. */
export function decodeExistingProject(encoded: string, home: string, known: string[] = []): string[] {
  const matches = new Set(known.filter(p => encodePath(p) === encoded));
  let budget = 10000;
  function descend(base: string, depth: number): void {
    if (--budget <= 0 || depth > 30) return;
    const key = encodePath(base);
    if (key === encoded) { matches.add(base); return; }
    if (key && !encoded.startsWith(key + '-')) return;
    for (const e of directoryEntries(base)) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const child = path.join(base, e.name); const childKey = encodePath(child);
      if (childKey === encoded || encoded.startsWith(childKey + '-')) descend(child, depth + 1);
    }
  }
  descend(encodePath(home) === encoded || encoded.startsWith(encodePath(home) + '-') ? home : path.parse(home).root, 0);
  return [...matches].sort();
}

export function loadCursor(home: string = os.homedir()): CursorRecord[] {
  const records = new Map<string, CursorRecord>();
  const knownCwds = new Set<string>();
  function merge(record: CursorRecord): void {
    const prior = records.get(record.id);
    if (!prior) { records.set(record.id, record); return; }
    const sources = [...new Set([...(prior.sources || [prior.source]), record.source])];
    const datesFirst = [prior.firstAt, record.firstAt].filter((v): v is string => !!v).sort();
    const datesLast = [prior.lastAt, record.lastAt].filter((v): v is string => !!v).sort();
    records.set(record.id, { ...prior, ...record, cwd: record.source === 'transcript' && prior.cwd ? prior.cwd : record.cwd || prior.cwd,
      attributionEvidence: record.source === 'transcript' && prior.cwd ? prior.attributionEvidence : record.attributionEvidence,
      source: sources.join('+'), sources, firstAt: datesFirst[0], lastAt: datesLast.at(-1),
      repoHints: [...new Set([...(prior.repoHints || []), ...(record.repoHints || [])])] });
  }
  const sdkRoot = path.join(home, 'Library/Application Support/com.conductor.app/cursor-sdk-store');
  for (const store of directoryEntries(sdkRoot)) {
    if (!store.isDirectory()) continue;
    const dir = path.join(sdkRoot, store.name);
    const agents = new Map<string, any>();
    for (const row of readRows(path.join(dir, 'agents.ndjson'))) if (typeof row.agentId === 'string') agents.set(row.agentId, row);
    const runs = new Map<string, any>();
    for (const row of readRows(path.join(dir, 'runs.ndjson'))) if (typeof row.runId === 'string') runs.set(row.runId, row);
    for (const [id, agent] of agents) {
      const agentRuns = [...runs.values()].filter(r => r.agentId === id);
      const cwd = uriPath(agent.cwd); if (cwd) knownCwds.add(cwd);
      const first = [iso(agent.createdAt), ...agentRuns.map(r => iso(r.startedAt || r.createdAt))].filter(Boolean).sort();
      const last = [iso(agent.updatedAt), ...agentRuns.map(r => iso(r.endedAt || r.updatedAt || r.createdAt))].filter(Boolean).sort();
      const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
      const usageFields = { input: 'inputTokens', output: 'outputTokens', cacheRead: 'cacheReadTokens', cacheWrite: 'cacheWriteTokens', reasoning: 'reasoningTokens' };
      for (const run of agentRuns) for (const key of Object.keys(tokens) as (keyof typeof tokens)[]) tokens[key] += Number(run.usage?.[usageFields[key]] || 0);
      merge({ provider: 'cursor', id, cwd, source: 'sdk', attributionEvidence: cwd ? 'agent.cwd' : 'missing-cwd', firstAt: first[0], lastAt: last.at(-1), tokens,
        models: [...new Set(agentRuns.map(r => r.model?.id).filter((x): x is string => typeof x === 'string'))] });
    }
  }
  const cursorSupport = path.join(home, 'Library/Application Support/Cursor/User');
  const workspaces = new Map<string, string[]>();
  for (const entry of directoryEntries(path.join(cursorSupport, 'workspaceStorage'))) {
    if (!entry.isDirectory()) continue;
    const manifest = readJson(path.join(cursorSupport, 'workspaceStorage', entry.name, 'workspace.json'));
    if (!manifest) continue;
    const folders: string[] = [];
    const single = uriPath(manifest.folder); if (single) folders.push(single);
    const multi = uriPath(manifest.workspace);
    if (multi) {
      const config = readJson(multi);
      for (const folder of config?.folders || []) { const p = uriPath(folder.uri) || (typeof folder.path === 'string' ? path.resolve(path.dirname(multi), folder.path) : undefined); if (p) folders.push(p); }
    }
    if (folders.length) { workspaces.set(entry.name, folders); folders.forEach(p => knownCwds.add(p)); }
  }
  try {
    const db = new DatabaseSync(path.join(cursorSupport, 'globalStorage/state.vscdb'), { readOnly: true });
    try {
      const data = new Map<string, any>();
      for (const row of db.prepare("SELECT key,value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all()) {
        try { const v = JSON.parse(typeof row.value === 'string' ? row.value : Buffer.from(row.value as Uint8Array).toString('utf8')); data.set(String(row.key).slice('composerData:'.length), v); } catch {}
      }
      for (const row of db.prepare('SELECT composerId,workspaceId,createdAt,lastUpdatedAt,value FROM composerHeaders').all()) {
        let header: any = {}; try { header = JSON.parse(String(row.value)); } catch {}
        const id = String(row.composerId); const composer = data.get(id) || {};
        const workspaceId = String(row.workspaceId || header.workspaceIdentifier?.id || composer.workspaceIdentifier?.id || '');
        const folders = workspaces.get(workspaceId) || [];
        const tracked = [...(Array.isArray(composer.trackedGitRepos) ? composer.trackedGitRepos : []), ...(Array.isArray(header.trackedGitRepos) ? header.trackedGitRepos : [])].flatMap((r: any) => {
          const raw = typeof r === 'string' ? r : r?.rootPath || r?.rootUri || r?.path || r?.uri;
          const p = uriPath(raw); return p ? [p] : [];
        });
        merge({ provider: 'cursor', id, cwd: folders.length === 1 ? folders[0] : undefined, repoHints: tracked,
          candidates: folders, source: 'composer', attributionEvidence: folders.length === 1 ? 'workspace.folder' : folders.length > 1 ? 'ambiguous-multi-root' : 'missing-workspace',
          firstAt: iso(row.createdAt) || iso(composer.createdAt), lastAt: iso(row.lastUpdatedAt) || iso(composer.lastUpdatedAt), isDraft: !!(header.isDraft || composer.isDraft) });
      }
    } finally { db.close(); }
  } catch {}
  const projectRoot = path.join(home, '.cursor/projects');
  for (const project of directoryEntries(projectRoot)) {
    if (!project.isDirectory()) continue;
    const candidates = decodeExistingProject(project.name, home, [...knownCwds]);
    const cwd = candidates.length === 1 ? candidates[0] : undefined;
    function scan(dir: string): void {
      for (const entry of directoryEntries(dir)) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) { scan(file); continue; }
        if (!entry.name.endsWith('.jsonl')) continue;
        const id = entry.name.slice(0, -'.jsonl'.length);
        merge({ provider: 'cursor', id, cwd, source: 'transcript', attributionEvidence: cwd ? (fs.existsSync(cwd) ? 'unique-existing-encoded-directory' : 'unique-metadata-encoded-directory') : candidates.length ? 'ambiguous-encoded-directory' : 'missing-encoded-directory',
          candidates, fileMtime: fs.statSync(file).mtime.toISOString() });
      }
    }
    scan(path.join(projectRoot, project.name, 'agent-transcripts'));
  }
  return [...records.values()];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const records = loadCursor();
  const count = (get: (r: CursorRecord) => string) => Object.fromEntries([...new Set(records.map(get))].sort().map(k => [k, records.filter(r => get(r) === k).length]));
  const evidence = { generatedAt: new Date().toISOString(), total: records.length, sources: count(r => r.source), attribution: count(r => r.attributionEvidence),
    drafts: records.filter(r => r.isDraft).length, distinctCwds: new Set(records.map(r => r.cwd).filter(Boolean)).size,
    records: records.map(r => ({ key: hash('cursor:' + r.id), source: r.source, evidence: r.attributionEvidence, cwdKey: r.cwd ? hash(r.cwd) : null, candidates: r.candidates?.length || 0, firstAt: r.firstAt, lastAt: r.lastAt })) };
  fs.writeFileSync(path.resolve('.lane/cursor-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({total:evidence.total,sources:evidence.sources,attribution:evidence.attribution,drafts:evidence.drafts,distinctCwds:evidence.distinctCwds}));
}
