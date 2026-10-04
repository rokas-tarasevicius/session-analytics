import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { loadCursor, decodeExistingProject } from './cursor-oracle.ts';
const encode = (p: string) => p.replace(/[^A-Za-z0-9]/g, '-').replace(/^-+/, '');
function fixture(t: any): string { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-cursor-oracle-')); t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p; }
function write(p: string, value: unknown): void { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(value) + '\n'); }

test('independent Cursor oracle resolves encoded directories without replacing literal hyphens', t => {
  const home = fixture(t); const cwd = path.join(home, 'alpha-beta', 'nested'); fs.mkdirSync(cwd, { recursive: true });
  assert.deepEqual(decodeExistingProject(encode(cwd), home), [cwd]);
});

test('independent Cursor oracle preserves ambiguous encoded directories', t => {
  const home = fixture(t); const a = path.join(home, 'alpha-beta'); const b = path.join(home, 'alpha', 'beta');
  fs.mkdirSync(a, { recursive: true }); fs.mkdirSync(b, { recursive: true });
  assert.deepEqual(decodeExistingProject(encode(a), home), [a, b].sort());
  write(path.join(home, '.cursor/projects', encode(a), 'agent-transcripts', 'synthetic-agent.jsonl'), { role: 'user', message: { content: [] } });
  const [record] = loadCursor(home); assert.equal(record?.cwd, undefined); assert.equal(record?.attributionEvidence, 'ambiguous-encoded-directory');
});

test('independent Cursor oracle joins SDK IDs to transcripts and deduplicates latest run rows', t => {
  const home = fixture(t); const cwd = path.join(home, 'synthetic-project'); fs.mkdirSync(cwd);
  const store = path.join(home, 'Library/Application Support/com.conductor.app/cursor-sdk-store', 'store');
  write(path.join(store, 'agents.ndjson'), { agentId: 'synthetic-agent', cwd, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:10Z' });
  write(path.join(store, 'runs.ndjson'), { runId: 'run', agentId: 'synthetic-agent', usage: { inputTokens: 20, outputTokens: 10 }, model: { id: 'synthetic-model' }, startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:00:15Z' });
  fs.appendFileSync(path.join(store, 'runs.ndjson'), JSON.stringify({ runId: 'run', agentId: 'synthetic-agent', usage: { inputTokens: 30, outputTokens: 15 }, model: { id: 'synthetic-model' }, endedAt: '2026-01-01T00:00:20Z' }) + '\n');
  write(path.join(home, '.cursor/projects', encode(cwd), 'agent-transcripts', 'synthetic-agent.jsonl'), { role: 'assistant', message: { content: [] } });
  const records = loadCursor(home); assert.equal(records.length, 1); const record = records[0]!;
  assert.equal(record.cwd, cwd); assert.equal(record.source, 'sdk+transcript'); assert.equal(record.tokens?.input, 30); assert.equal(record.lastAt, '2026-01-01T00:00:20.000Z');
});

test('independent Cursor composer oracle decodes workspace file URIs', t => {
  const home = fixture(t); const cwd = path.join(home, 'synthetic project'); fs.mkdirSync(cwd);
  const root = path.join(home, 'Library/Application Support/Cursor/User');
  write(path.join(root, 'workspaceStorage/workspace-id/workspace.json'), { folder: pathToFileURL(cwd).href });
  fs.mkdirSync(path.join(root, 'globalStorage'), { recursive: true });
  const db = new DatabaseSync(path.join(root, 'globalStorage/state.vscdb'));
  db.exec('CREATE TABLE cursorDiskKV(key TEXT,value TEXT); CREATE TABLE composerHeaders(composerId TEXT,workspaceId TEXT,createdAt INTEGER,lastUpdatedAt INTEGER,value TEXT)');
  db.prepare('INSERT INTO composerHeaders VALUES(?,?,?,?,?)').run('synthetic-composer', 'workspace-id', Date.UTC(2026,0,1), Date.UTC(2026,0,2), '{}'); db.close();
  const [record] = loadCursor(home); assert.equal(record?.cwd, cwd); assert.equal(record?.source, 'composer'); assert.equal(record?.attributionEvidence, 'workspace.folder');
});


test('independent Cursor oracle preserves authoritative SDK cwd over a conflicting transcript folder', t => {
  const home = fixture(t); const sdkCwd = path.join(home, 'synthetic-sdk'); const transcriptCwd = path.join(home, 'synthetic-transcript');
  fs.mkdirSync(sdkCwd); fs.mkdirSync(transcriptCwd);
  write(path.join(home, 'Library/Application Support/com.conductor.app/cursor-sdk-store/store/agents.ndjson'), { agentId: 'synthetic-agent', cwd: sdkCwd });
  write(path.join(home, '.cursor/projects', encode(transcriptCwd), 'agent-transcripts/synthetic-agent.jsonl'), { role: 'user', message: { content: [] } });
  const [record] = loadCursor(home); assert.equal(record?.cwd, sdkCwd); assert.equal(record?.attributionEvidence, 'agent.cwd');
});
