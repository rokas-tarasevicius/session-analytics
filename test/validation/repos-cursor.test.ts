import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { analyzeMachineSessions, cursorSessions } from '../../src/analyzer.ts';
import { NO_REPOSITORY_ID } from '../../verify/repos/inventory-roots.ts';
import type { RepositoryRow } from '../../src/analyzer.ts';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'repo-cursor-validation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repos: RepositoryRow[] = [];
  for (const name of ['synthetic-primary', 'synthetic-reference']) {
    const directory = join(root, name); await mkdir(join(directory, '.git'), { recursive: true });
    repos.push({ id: name, name, root_path: directory, remote_url: null, default_branch: '' });
  }
  return { root, repos };
}
async function composerStore(root: string, data: Record<string, unknown>, workspace?: Record<string, unknown>) {
  const user = join(root, 'Cursor/User');
  await mkdir(join(user, 'globalStorage'), { recursive: true });
  if (workspace) {
    await mkdir(join(user, 'workspaceStorage/synthetic-workspace'), { recursive: true });
    await writeFile(join(user, 'workspaceStorage/synthetic-workspace/workspace.json'), JSON.stringify(workspace));
  }
  const file = join(user, 'globalStorage/state.vscdb'); const db = new DatabaseSync(file);
  db.exec('CREATE TABLE cursorDiskKV(key TEXT,value TEXT); CREATE TABLE ItemTable(key TEXT,value TEXT); CREATE TABLE composerHeaders(composerId TEXT,workspaceId TEXT,lastUpdatedAt INTEGER,isSubagent INTEGER)');
  db.prepare('INSERT INTO cursorDiskKV VALUES(?,?)').run('composerData:synthetic-composer', JSON.stringify({ composerId: 'synthetic-composer', createdAt: Date.UTC(2026,0,1), conversation: [{ type: 1, text: 'synthetic-private-sentinel' }], ...data }));
  if (workspace) db.prepare('INSERT INTO composerHeaders VALUES(?,?,?,?)').run('synthetic-composer', 'synthetic-workspace', Date.UTC(2026,0,1), 0);
  db.close(); return file;
}

test('R-CURSOR-01: a referenced repository cannot override the composer workspace', async t => {
  const { root, repos } = await fixture(t);
  const file = await composerStore(root, { context: { fileSelections: [{ uri: pathToFileURL(join(repos[1]!.root_path, 'reference.ts')).href }] } }, { folder: pathToFileURL(repos[0]!.root_path).href });
  const result = await cursorSessions(file, repos, new Map(), new Map());
  assert.equal(result.warning, null); assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0]!.repositoryName, 'synthetic-primary');
  assert.ok(!JSON.stringify(result).includes('synthetic-private-sentinel'));
});

test('R-CURSOR-01: conversation text that happens to be an absolute path is not cwd evidence', async t => {
  const { root, repos } = await fixture(t);
  const file = await composerStore(root, { conversation: [{ type: 1, text: repos[1]!.root_path }] }, { folder: pathToFileURL(repos[0]!.root_path).href });
  const result = await cursorSessions(file, repos, new Map(), new Map());
  assert.equal(result.sessions[0]!.repositoryName, 'synthetic-primary');
});

test('R-CURSOR-02: a one-folder code-workspace maps to its folder, not the workspace file directory', async t => {
  const { root, repos } = await fixture(t);
  const config = join(root, 'workspace-files/project.code-workspace');
  await mkdir(join(root, 'workspace-files')); await writeFile(config, JSON.stringify({ folders: [{ path: '../synthetic-primary' }] }));
  const file = await composerStore(root, {}, { workspace: pathToFileURL(config).href });
  const result = await cursorSessions(file, repos, new Map(), new Map());
  assert.equal(result.sessions[0]!.repositoryName, 'synthetic-primary');
});

test('R-CURSOR-03: a composer without any cwd evidence is unassigned, not a local directory', async t => {
  const { root, repos } = await fixture(t); const file = await composerStore(root, {});
  const result = await cursorSessions(file, repos, new Map(), new Map());
  assert.equal(result.sessions.length, 1);
  assert.match(result.sessions[0]!.repositoryName, /unassigned/i);
  assert.doesNotMatch(result.sessions[0]!.repositoryName, /\(local directory\)/);
});

test('R-CURSOR-01: a message-only absolute path without a workspace header leaves a composer unassigned', async t => {
  const { root, repos } = await fixture(t);
  const file = await composerStore(root, { conversation: [{ type: 1, text: repos[1]!.root_path }] });
  const result = await cursorSessions(file, repos, new Map(), new Map());
  assert.equal(result.sessions.length, 1);
  assert.match(result.sessions[0]!.repositoryName, /unassigned/i);
});

test('R-CURSOR-04: Cursor, its agent transcripts and Claude in separate non-repository folders share one group row', async t => {
  const { root } = await fixture(t);
  // Never created and outside the temporary directory: folders with no repository evidence.
  const outside = `/session-analytics-cursor-fixture-${process.pid}`;
  const cursorFolder = join(outside, 'cursor-folder'), claudeFolder = join(outside, 'claude-folder');
  const file = await composerStore(root, {}, { folder: pathToFileURL(cursorFolder).href });
  const id = '20000000-0000-4000-8000-000000000001', at = '2026-01-01T00:00:00.000Z';
  for (const directory of ['claude', 'codex', 'archive']) await mkdir(join(root, directory));
  await writeFile(join(root, 'claude', `${id}.jsonl`), [
    { type: 'user', sessionId: id, cwd: claudeFolder, timestamp: at, message: { role: 'user', content: 'synthetic' } },
    { type: 'assistant', sessionId: id, cwd: claudeFolder, timestamp: at, message: { id: 'message-1', role: 'assistant', model: 'claude-opus-4-6', content: [], usage: { input_tokens: 10, output_tokens: 1 } } },
  ].map(record => JSON.stringify(record)).join('\n') + '\n');
  // Cursor names agent-transcript projects after the encoded folder path; only a known path can match it.
  const project = cursorFolder.replace(/^\//, '').replace(/[^A-Za-z0-9]/g, '-');
  await mkdir(join(root, 'transcripts', project, 'agent-transcripts'), { recursive: true });
  await writeFile(join(root, 'transcripts', project, 'agent-transcripts', '30000000-0000-4000-8000-000000000001.jsonl'),
    JSON.stringify({ role: 'user', message: { content: 'synthetic' } }) + '\n');
  const result = await analyzeMachineSessions({ noIndex: true, additionalProviders: false, pricingPolicy: 'reviewed-only',
    dataDir: join(root, 'data'), claudeRoot: join(root, 'claude'), codexRoot: join(root, 'codex'), codexArchiveRoot: join(root, 'archive'),
    cursorDatabasePath: file, databasePath: join(root, 'missing-conductor.db'), cursorTranscriptRoot: join(root, 'transcripts') });
  assert.equal(result.sessions.length, 3);
  assert.deepEqual([...new Set(result.sessions.map(s => s.repositoryId))], [NO_REPOSITORY_ID]);
  assert.equal(result.repositories.filter(r => r.repository.id === NO_REPOSITORY_ID).length, 1);
  assert.equal(JSON.stringify(result).includes('cursor-folder'), false);
});
