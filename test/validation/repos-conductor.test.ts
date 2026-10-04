import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { analyzeMachineSessions } from '../../src/analyzer.ts';

const registeredId = 'conductor-' + createHash('sha256').update('conductor:synthetic-repo').digest('hex').slice(0, 20);
const providerId = '12345678-1234-4234-8234-123456789abc';

async function fixture(run: (root: string, db: DatabaseSync, databasePath: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'repos-conductor-validation-'));
  const databasePath = join(root, 'conductor.db');
  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE repos (id TEXT PRIMARY KEY, name TEXT, root_path TEXT, remote_url TEXT, default_branch TEXT, hidden INTEGER DEFAULT 0);
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, repository_id TEXT, workspace_name TEXT, workspace_path TEXT, branch TEXT, directory_name TEXT, secondary_directory_name TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT, agent_type TEXT, title TEXT, created_at TEXT, updated_at TEXT, claude_session_id TEXT, model TEXT, is_hidden INTEGER DEFAULT 0, workspace_id TEXT);
  `);
  db.prepare('INSERT INTO repos (id,name,root_path,remote_url,default_branch) VALUES (?,?,?,?,?)').run('synthetic-repo', 'synthetic-project', join(root, 'registered'), 'https://example.invalid/owner/project.git', 'main');
  try { await run(root, db, databasePath); }
  finally { db.close(); await rm(root, { recursive: true, force: true }); }
}

function workspace(db: DatabaseSync, cwd: string, secondary: string | null = null): void {
  db.prepare('INSERT INTO workspaces VALUES (?,?,?,?,?,?,?)').run('synthetic-workspace', 'synthetic-repo', 'synthetic-workspace', cwd, 'synthetic-branch', 'primary', secondary);
}

function anchorSession(db: DatabaseSync): void {
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?)').run('synthetic-anchor', 'idle', 'codex', 'synthetic-title', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'absent-anchor-provider-id', 'gpt-5', 0, 'synthetic-workspace');
}

async function analyze(root: string, databasePath: string, cwd: string) {
  const codexRoot = join(root, 'codex-sessions');
  const claudeRoot = join(root, 'claude-projects');
  const archive = join(root, 'codex-archive');
  await Promise.all([mkdir(codexRoot), mkdir(claudeRoot), mkdir(archive)]);
  await writeFile(join(codexRoot, `rollout-${providerId}.jsonl`), [
    { type: 'session_meta', timestamp: '2026-02-01T00:00:00Z', payload: { id: providerId, cwd, source: 'cli' } },
    { type: 'turn_context', timestamp: '2026-02-01T00:00:00Z', payload: { cwd, model: 'gpt-5' } },
    { type: 'event_msg', timestamp: '2026-02-01T00:00:10Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 110 } } } },
  ].map(record => JSON.stringify(record)).join('\n') + '\n');
  return analyzeMachineSessions({ noIndex: true, additionalProviders: false, pricingPolicy: 'reviewed-only', dataDir: join(root, 'analytics'), databasePath, cursorDatabasePath: join(root, 'absent-cursor.db'), claudeRoot, codexRoot, codexArchiveRoot: archive });
}

test('R-CONDUCTOR-01: a workspace without registered sessions still attributes native provider sessions', async () => {
  await fixture(async (root, db, databasePath) => {
    const cwd = join(root, 'custom-workspace-storage', 'primary');
    workspace(db, cwd);
    const result = await analyze(root, databasePath, cwd);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0]?.repositoryId, registeredId);
  });
});

test('R-CONDUCTOR-01: a deleted secondary workspace alias retains its recorded repository', async () => {
  await fixture(async (root, db, databasePath) => {
    const cwd = join(root, 'custom-workspace-storage', 'primary');
    workspace(db, cwd, 'historical-alias');
    anchorSession(db);
    const result = await analyze(root, databasePath, join(dirname(cwd), 'historical-alias'));
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0]?.repositoryId, registeredId);
  });
});

test('R-CONDUCTOR-02: a deleted custom workspace subdirectory retains its recorded repository', async () => {
  await fixture(async (root, db, databasePath) => {
    const cwd = join(root, 'custom-workspace-storage', 'primary');
    workspace(db, cwd);
    anchorSession(db);
    const result = await analyze(root, databasePath, join(cwd, 'packages', 'synthetic-package'));
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0]?.repositoryId, registeredId);
  });
});
