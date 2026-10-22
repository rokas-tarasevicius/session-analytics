// Intentional failing regressions for v-repos validation. All evidence is synthetic.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { analyzeMachineSessions, windowsPathUnder } from '../../src/analyzer.ts';
import { openIndexDatabase } from '../../src/store/database.ts';
import { keyedHash } from '../../src/store/fingerprint.ts';
import { NO_REPOSITORY_ID } from '../../verify/repos/git-oracle.ts';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'repos-git-validation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['claude', 'codex', 'archive']) await mkdir(join(root, dir));
  const databasePath = join(root, 'conductor.db');
  const db = new DatabaseSync(databasePath);
  db.exec(`CREATE TABLE repos (id TEXT, name TEXT, root_path TEXT, remote_url TEXT, default_branch TEXT, hidden INTEGER DEFAULT 0);
    CREATE TABLE workspaces (id TEXT, repository_id TEXT, workspace_name TEXT, workspace_path TEXT, branch TEXT);
    CREATE TABLE sessions (id TEXT, status TEXT, agent_type TEXT, title TEXT, created_at TEXT, updated_at TEXT, claude_session_id TEXT, model TEXT, is_hidden INTEGER, workspace_id TEXT);`);
  db.close();
  const options = { noIndex: true as const, additionalProviders: false as const, pricingPolicy: 'reviewed-only' as const,
    dataDir: join(root, 'data'), claudeRoot: join(root, 'claude'), codexRoot: join(root, 'codex'), codexArchiveRoot: join(root, 'archive'),
    cursorDatabasePath: join(root, 'missing-cursor'), databasePath };
  let counter = 0;
  return { root, options,
    async git(path: string, remote: string | null = 'https://one.test/owner/project.git') {
      await mkdir(join(path, '.git'), { recursive: true });
      await writeFile(join(path, '.git/config'), remote ? `[remote "origin"]\n url = ${remote}\n` : '[core]\n bare = false\n');
    },
    register(path: string, remote = 'https://one.test/owner/project.git', name = 'project') {
      const db = new DatabaseSync(databasePath); db.prepare('INSERT INTO repos VALUES (?,?,?,?,?,0)').run(`repo-${++counter}`, name, path, remote, 'main'); db.close();
    },
    async session(cwd: string, provider: 'claude' | 'codex' = 'claude', remote?: string) {
      const n = ++counter;
      const id = `10000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
      const at = '2026-09-01T12:00:00.000Z';
      const records = provider === 'claude' ? [
        { type: 'user', sessionId: id, cwd, timestamp: at, message: { role: 'user', content: 'synthetic' } },
        { type: 'assistant', sessionId: id, cwd, timestamp: '2026-09-01T12:00:01.000Z', message: { id: `message-${n}`, role: 'assistant', model: 'claude-opus-4-6', content: [], usage: { input_tokens: 100 + n, output_tokens: 10 } } },
      ] : [
        { type: 'session_meta', timestamp: at, payload: { id, cwd, git: { repository_url: remote } } },
        { type: 'turn_context', timestamp: at, payload: { model: 'gpt-5.4' } },
        { type: 'event_msg', timestamp: '2026-09-01T12:00:01.000Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100 + n, output_tokens: 10 }, last_token_usage: { input_tokens: 100 + n, output_tokens: 10 } } } },
      ];
      await writeFile(join(root, provider, `${id}.jsonl`), records.map(r => JSON.stringify(r)).join('\n') + '\n');
      return createHash('sha256').update(`${provider}:${id}`).digest('hex').slice(0, 12);
    },
  };
}

test('R-GIT-01: symlink and canonical paths share a single Git repository', async t => {
  const f = await fixture(t); const actual = join(f.root, 'actual'); await f.git(actual);
  const alias = join(f.root, 'alias'); await symlink(actual, alias);
  await f.session(actual); await f.session(alias);
  const result = await analyzeMachineSessions(f.options);
  assert.equal(result.sessions.length, 2);
  assert.equal(new Set(result.sessions.map(s => s.repositoryId)).size, 1);
});

test('R-GIT-01: a registered symlink root matches its canonical filesystem root', async t => {
  const f = await fixture(t); const actual = join(f.root, 'actual'); await f.git(actual);
  const alias = join(f.root, 'alias'); await symlink(actual, alias); f.register(alias);
  await f.session(actual);
  const result = await analyzeMachineSessions(f.options);
  assert.equal(result.sessions.length, 1);
  assert.ok(result.sessions[0]!.repositoryId.startsWith('conductor-'));
});

test('R-GIT-02: nearest nested Git repository wins over registered ancestor containment', async t => {
  const f = await fixture(t); const outer = join(f.root, 'outer'); const inner = join(outer, 'inner');
  await f.git(outer); await f.git(inner, 'https://two.test/owner/project.git'); f.register(outer);
  const a = await f.session(outer); const b = await f.session(inner);
  const result = await analyzeMachineSessions(f.options);
  assert.notEqual(result.sessions.find(s => s.sessionKey === a)?.repositoryId, result.sessions.find(s => s.sessionKey === b)?.repositoryId);
});

test('R-GIT-02: live Git identity wins over a coincidental Conductor path basename', async t => {
  const f = await fixture(t); const registered = join(f.root, 'registered'); await f.git(registered); f.register(registered);
  const other = join(f.root, 'conductor/workspaces/project/workspace'); await f.git(other, 'https://two.test/elsewhere/project.git');
  const a = await f.session(registered); const b = await f.session(other);
  const result = await analyzeMachineSessions(f.options);
  assert.notEqual(result.sessions.find(s => s.sessionKey === a)?.repositoryId, result.sessions.find(s => s.sessionKey === b)?.repositoryId);
});

test('R-GIT-03: independent clones of one canonical remote form one repository row', async t => {
  const f = await fixture(t); const one = join(f.root, 'one'); const two = join(f.root, 'two');
  await f.git(one); await f.git(two, 'git@one.test:owner/project.git'); await f.session(one); await f.session(two);
  const result = await analyzeMachineSessions(f.options);
  assert.equal(result.sessions.length, 2);
  assert.equal(new Set(result.sessions.map(s => s.repositoryId)).size, 1);
  for (const noIndex of [true, false]) {
    const filtered = await analyzeMachineSessions({ ...f.options, noIndex, repositoryRoot: two });
    assert.equal(filtered.sessions.length, 2, 'every current checkout root selects its logical repository');
  }
});

test('R-GIT-04: historical Codex remote recovers two removed checkouts of one repository', async t => {
  const f = await fixture(t);
  await f.session(join(f.root, 'removed-one'), 'codex', 'https://one.test/owner/project.git');
  await f.session(join(f.root, 'removed-two'), 'codex', 'git@one.test:owner/project.git');
  const result = await analyzeMachineSessions(f.options);
  assert.equal(result.sessions.length, 2);
  assert.equal(new Set(result.sessions.map(s => s.repositoryId)).size, 1);
  assert.ok(result.sessions.every(s => !s.repositoryName.includes('(local directory)') && s.repositoryName !== 'Ephemeral automation sessions'));
});

test('R-GIT-05: linked worktrees with external common Git storage share an identity', async t => {
  const f = await fixture(t); const storage = join(f.root, 'metadata');
  await mkdir(join(storage, 'worktrees/first'), { recursive: true }); await mkdir(join(storage, 'worktrees/second'), { recursive: true });
  await writeFile(join(storage, 'config'), '[core]\n bare = false\n');
  for (const name of ['first', 'second']) {
    const tree = join(f.root, name); await mkdir(tree);
    await writeFile(join(tree, '.git'), `gitdir: ../metadata/worktrees/${name}\n`);
    await writeFile(join(storage, 'worktrees', name, 'commondir'), '../..\n');
    await f.session(tree);
  }
  const result = await analyzeMachineSessions(f.options);
  assert.equal(result.sessions.length, 2);
  assert.equal(new Set(result.sessions.map(s => s.repositoryId)).size, 1);
});

test('R-GIT-04: a removed nested checkout uses its historical remote instead of the surviving ancestor', async t => {
  const f = await fixture(t); const outer = join(f.root, 'outer'); await f.git(outer); f.register(outer);
  const outerKey = await f.session(outer);
  const historicalKey = await f.session(join(outer, 'removed'), 'codex', 'https://two.test/team/project.git');
  const result = await analyzeMachineSessions(f.options);
  assert.notEqual(result.sessions.find(s => s.sessionKey === outerKey)?.repositoryId, result.sessions.find(s => s.sessionKey === historicalKey)?.repositoryId);
});

test('R-GIT-06: SSH URL and HTTPS URL filters identify the same registered repository', async t => {
  const f = await fixture(t); const root = join(f.root, 'registered'); await f.git(root); f.register(root); await f.session(root);
  const result = await analyzeMachineSessions({ ...f.options, repositoryRemote: 'ssh://git@one.test/owner/project.git' });
  assert.equal(result.sessions.length, 1);
});

test('R-GIT-06: a trailing slash after .git does not break remote identity', async t => {
  const f = await fixture(t); const root = join(f.root, 'registered'); await f.git(root); f.register(root); await f.session(root);
  const result = await analyzeMachineSessions({ ...f.options, repositoryRemote: 'https://one.test/owner/project.git/' });
  assert.equal(result.sessions.length, 1);
});

test('R-GIT-06: case-sensitive self-hosted namespaces are not merged by a remote filter', async t => {
  const f = await fixture(t); const root = join(f.root, 'registered');
  const remote = 'https://self-hosted.test/Owner/project.git';
  await f.git(root, remote); f.register(root, remote); await f.session(root);
  await assert.rejects(analyzeMachineSessions({ ...f.options, repositoryRemote: 'https://self-hosted.test/owner/project.git' }));
});

test('R-GIT-06: an invalid remote filter cannot match a repository with no remote', async t => {
  const f = await fixture(t); const root = join(f.root, 'local'); await mkdir(root); await f.session(root);
  await assert.rejects(analyzeMachineSessions({ ...f.options, repositoryRemote: 'not-a-remote' }));
});

test('control: actual repositories inside temporary folders retain separate Git identities', async t => {
  const f = await fixture(t);
  for (const name of ['alpha', 'beta']) {
    const root = join(f.root, name); await f.git(root, `https://one.test/owner/${name}.git`); await f.session(root);
  }
  const result = await analyzeMachineSessions(f.options);
  assert.equal(result.sessions.length, 2);
  assert.equal(new Set(result.sessions.map(s => s.repositoryId)).size, 2);
  assert.ok(result.sessions.every(s => s.repositoryName !== 'Ephemeral automation sessions'));
});

test('control: same basename on distinct hosts and namespaces remains distinct', async t => {
  const f = await fixture(t);
  for (const [folder, remote] of [['a', 'https://one.test/team/project.git'], ['b', 'https://two.test/team/project.git'], ['c', 'https://one.test/other/project.git']]) {
    const root = join(f.root, folder!); await f.git(root, remote!); await f.session(root);
  }
  const result = await analyzeMachineSessions(f.options);
  assert.equal(result.sessions.length, 3);
  assert.equal(new Set(result.sessions.map(s => s.repositoryId)).size, 3);
});

test('control: standard .git/worktrees layout groups with the main checkout', async t => {
  const f = await fixture(t); const main = join(f.root, 'main'); const tree = join(f.root, 'tree');
  await f.git(main); await mkdir(join(main, '.git/worktrees/tree'), { recursive: true }); await mkdir(tree);
  await writeFile(join(tree, '.git'), 'gitdir: ../main/.git/worktrees/tree\n');
  await writeFile(join(main, '.git/worktrees/tree/commondir'), '../..\n');
  await f.session(main); await f.session(tree);
  const result = await analyzeMachineSessions(f.options);
  assert.equal(new Set(result.sessions.map(s => s.repositoryId)).size, 1);
});

// Directories without a Git root, a recorded remote or Conductor ownership are not
// repositories. Paths outside the OS temporary directory are synthetic and never
// created, so they also stand in for deleted directories.
const outside = `/session-analytics-fixture-${process.pid}-${Date.now()}`;
const NO_REPOSITORY = 'No repository detected';

test('R-LOCAL-01: home, scratch, download and chat folders share one no-repository group', async t => {
  const f = await fixture(t);
  const keys: string[] = [];
  for (const cwd of [join(outside, 'home'), join(outside, 'home/Downloads/report'), join(outside, 'home/Desktop/scratch'),
    join(outside, 'home/Documents/Codex/2026-01-01/a-chat-title'), join(outside, 'home/Documents/Codex/2026-01-02/another-chat')]) {
    keys.push(await f.session(cwd, 'claude')); keys.push(await f.session(cwd, 'codex'));
  }
  const result = await analyzeMachineSessions(f.options);
  assert.equal(result.sessions.length, keys.length);
  assert.equal(new Set(result.sessions.map(s => s.repositoryId)).size, 1);
  assert.ok(result.sessions.every(s => s.repositoryName === NO_REPOSITORY));
  assert.equal(result.sessions[0]!.repositoryId, NO_REPOSITORY_ID, 'the product and the independent oracle agree on the group ID');
  assert.deepEqual(result.repositories.filter(r => r.summary.sessions > 0).map(r => r.repository.name), [NO_REPOSITORY]);
  // Neither the group name nor its ID carries a folder name or path.
  const serialized = JSON.stringify(result);
  for (const fragment of ['a-chat-title', 'another-chat', 'Downloads', 'scratch', outside]) assert.equal(serialized.includes(fragment), false, fragment);
});

test('R-LOCAL-01: deleted checkouts keep their recorded remote; deleted folders without one join the group', async t => {
  const f = await fixture(t);
  const remembered = await f.session(join(outside, 'removed-worktree'), 'codex', 'https://one.test/owner/project.git');
  const forgotten = await f.session(join(outside, 'removed-worktree-claude'), 'claude');
  const nested = await f.session(join(outside, 'removed-worktree-claude/tests/fixtures/sandbox'), 'claude');
  const result = await analyzeMachineSessions(f.options);
  const byKey = new Map(result.sessions.map(s => [s.sessionKey, s]));
  assert.equal(byKey.get(remembered)?.repositoryName, 'project');
  assert.equal(byKey.get(forgotten)?.repositoryName, NO_REPOSITORY);
  assert.equal(byKey.get(nested)?.repositoryId, byKey.get(forgotten)?.repositoryId);
});

test('R-LOCAL-01: a missing or plain subfolder of a repository stays with that repository', async t => {
  const f = await fixture(t); const root = join(f.root, 'checkout'); await f.git(root);
  await mkdir(join(root, 'packages/plain'), { recursive: true });
  const keys = [await f.session(root), await f.session(join(root, 'packages/plain')), await f.session(join(root, 'packages/removed/src'))];
  const result = await analyzeMachineSessions(f.options);
  assert.equal(new Set(keys.map(key => result.sessions.find(s => s.sessionKey === key)?.repositoryId)).size, 1);
  assert.ok(result.sessions.every(s => s.repositoryName === 'project'));
});

test('R-LOCAL-01: a deleted Conductor workspace of a registered repository is not bucketed', async t => {
  const f = await fixture(t); f.register(join(outside, 'conductor/repos/project'));
  const key = await f.session(join(outside, 'conductor/workspaces/project/removed-city'), 'claude');
  const result = await analyzeMachineSessions(f.options);
  const session = result.sessions.find(s => s.sessionKey === key);
  assert.ok(session?.repositoryId.startsWith('conductor-'));
  assert.equal(session?.repositoryName, 'project');
});

test('R-LOCAL-02: deleted fixture and macOS per-user temporary directories are ephemeral, not repositories', async t => {
  const f = await fixture(t);
  // The fixture temp root has no Git ancestors. Literal /tmp can legitimately
  // belong to a host repository; its spelling aliases are covered by the oracle.
  for (const cwd of [join(f.root, 'deleted-run.AAAA'), join(f.root, 'deleted-run.BBBB/orgs/one/workspaces/two'),
    '/var/folders/zz/synthetic000/T/tmp.CCCC', '/private/var/folders/zz/synthetic000/T/tool-DDDD/workspace']) await f.session(cwd, 'codex');
  const result = await analyzeMachineSessions(f.options);
  assert.equal(result.sessions.length, 4);
  assert.ok(result.sessions.every(s => s.repositoryName === 'Ephemeral automation sessions'));
});

/** A host Git marker legitimately changes attribution; never remove it to make a test pass. */
async function temporaryGitMarker(root: string): Promise<string | null> {
  const roots = new Set([resolve(root)]);
  try { roots.add(await realpath(root)); } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
  for (const spelling of roots) {
    for (let current = spelling; ; current = dirname(current)) {
      const marker = join(current, '.git');
      try {
        const info = await stat(marker);
        if (info.isDirectory() || info.isFile()) return marker;
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
      if (dirname(current) === current) break;
    }
  }
  return null;
}

for (const temporaryRoot of ['/tmp', '/private/tmp']) test(`R-LOCAL-02: deleted literal ${temporaryRoot} paths are ephemeral through the analyzer`, async t => {
  const marker = await temporaryGitMarker(temporaryRoot);
  if (marker) { t.skip(`Existing host Git marker ${marker} changes temporary-path attribution`); return; }
  const f = await fixture(t);
  // These unique recorded CWDs are deliberately absent, as after a temporary run is deleted.
  const deleted = join(temporaryRoot, `session-analytics-deleted-${process.pid}-${Date.now()}`);
  await assert.rejects(stat(deleted), { code: 'ENOENT' });
  for (const provider of ['claude', 'codex'] as const) {
    await f.session(deleted, provider);
    await f.session(join(deleted, 'orgs/one/workspaces/two'), provider);
  }
  const result = await analyzeMachineSessions(f.options);
  assert.equal(result.sessions.length, 4);
  assert.ok(result.sessions.every(s => s.repositoryName === 'Ephemeral automation sessions'));
  assert.equal(new Set(result.sessions.map(s => s.repositoryId)).size, 1);
  assert.equal(JSON.stringify(result).includes(deleted), false, 'temporary CWDs stay out of the public snapshot');
});

test('R-LOCAL-02: the real macOS /tmp alias and its canonical path share one ephemeral group', { skip: process.platform !== 'darwin' }, async t => {
  for (const temporaryRoot of ['/tmp', '/private/tmp']) {
    const marker = await temporaryGitMarker(temporaryRoot);
    if (marker) { t.skip(`Existing host Git marker ${marker} changes temporary-path attribution`); return; }
  }
  const f = await fixture(t);
  const scratch = await mkdtemp('/tmp/session-analytics-alias-');
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const canonical = await realpath(scratch);
  assert.equal(canonical, join('/private/tmp', scratch.slice('/tmp/'.length)), 'exercise the actual macOS filesystem alias');
  await f.session(scratch, 'claude'); await f.session(canonical, 'codex');
  const result = await analyzeMachineSessions(f.options);
  assert.equal(result.sessions.length, 2);
  assert.ok(result.sessions.every(s => s.repositoryName === 'Ephemeral automation sessions'));
  assert.equal(new Set(result.sessions.map(s => s.repositoryId)).size, 1);
});

test('R-LOCAL-02: an existing temporary folder is ephemeral through symlink and canonical spellings', async t => {
  const f = await fixture(t);
  const scratch = join(f.root, 'scratch'), alias = join(f.root, 'scratch-alias');
  await mkdir(scratch); await symlink(scratch, alias);
  await f.session(alias, 'claude'); await f.session(await realpath(scratch), 'claude');
  const result = await analyzeMachineSessions(f.options);
  assert.equal(result.sessions.length, 2);
  assert.ok(result.sessions.every(s => s.repositoryName === 'Ephemeral automation sessions'));
  assert.equal(new Set(result.sessions.map(s => s.repositoryId)).size, 1);
});

for (const keptFirst of [true, false]) test(`R-LOCAL-03: retained sessions from retired per-folder groups and the shared group form one group (${keptFirst ? 'shared group first' : 'legacy first'})`, async t => {
  const f = await fixture(t); const options = { ...f.options, noIndex: false as const };
  const kept = join(outside, 'kept'), legacyFolders = [join(outside, 'legacy-one'), join(outside, 'legacy-two')];
  const keys: string[] = [];
  for (const cwd of keptFirst ? [kept, ...legacyFolders] : [...legacyFolders, kept]) keys.push(await f.session(cwd));
  const legacyKeys = keptFirst ? keys.slice(1) : keys.slice(0, 2);
  await analyzeMachineSessions(options);
  // Rewrite two indexed sessions as an earlier release stored them, with a valid MAC.
  const connection = openIndexDatabase(options);
  try {
    for (const row of connection.database.prepare('SELECT scope,identity_key,payload FROM sessions').all()) {
      const session = JSON.parse(String(row.payload));
      const legacy = legacyKeys.indexOf(session.sessionKey) + 1;
      if (legacy < 1) continue;
      session.repositoryId = `discovered-${String(legacy).repeat(20)}`; session.repositoryName = `legacy-${legacy} · 000${legacy} (local directory)`;
      const payload = JSON.stringify(session);
      connection.database.prepare('UPDATE sessions SET payload=?,payload_mac=? WHERE scope=? AND identity_key=?')
        .run(payload, keyedHash(connection.secret, payload), row.scope!, row.identity_key!);
    }
  } finally { connection.close(); }
  // With every transcript gone no live session creates the shared group first.
  await rm(join(f.root, 'claude'), { recursive: true }); await mkdir(join(f.root, 'claude'));
  const result = await analyzeMachineSessions(options);
  assert.equal(result.sessions.length, 3);
  assert.ok(result.sessions.every(s => s.transcript.sourceDeleted && s.repositoryName === NO_REPOSITORY));
  assert.equal(new Set(result.sessions.map(s => s.repositoryId)).size, 1);
  assert.equal(result.repositories.filter(r => r.repository.id === result.sessions[0]!.repositoryId).length, 1);
  assert.equal(JSON.stringify(result).includes('(local directory)'), false);
});

test('R-GIT-WSL: a Windows drive path resolves through the WSL drive mount', async t => {
  const f = await fixture(t); const drives = join(f.root, 'mnt');
  await f.git(join(drives, 'd', 'GIT', 'project'));
  await mkdir(join(drives, 'd', 'GIT', 'project', 'src'));
  await f.session('D:\\GIT\\project'); await f.session('d:/GIT/project/src');
  const result = await analyzeMachineSessions({ ...f.options, windowsDriveRoot: drives });
  assert.equal(result.sessions.length, 2);
  assert.ok(result.sessions.every(s => s.repositoryId !== NO_REPOSITORY_ID && s.repositoryName === 'project'));
  assert.equal(new Set(result.sessions.map(s => s.repositoryId)).size, 1);
});

test('R-GIT-WSL: Windows drive paths stay unassigned without a drive mount', async t => {
  const f = await fixture(t); const drives = join(f.root, 'mnt');
  await f.git(join(drives, 'd', 'GIT', 'project'));
  await f.session('D:\\GIT\\project');
  const result = await analyzeMachineSessions({ ...f.options, windowsDriveRoot: null });
  assert.equal(result.sessions[0]!.repositoryId, NO_REPOSITORY_ID);
});

test('R-GIT-WSL: only absolute drive paths are translated', () => {
  assert.equal(windowsPathUnder('C:\\', '/mnt'), '/mnt/c');
  assert.equal(windowsPathUnder('D:\\GIT\\Lexori\\', '/mnt'), '/mnt/d/GIT/Lexori');
  assert.equal(windowsPathUnder('D:relative', '/mnt'), 'D:relative');
  assert.equal(windowsPathUnder('\\\\server\\share\\repo', '/mnt'), '\\\\server\\share\\repo');
  assert.equal(windowsPathUnder('/home/user/repo', '/mnt'), '/home/user/repo');
  assert.equal(windowsPathUnder('D:\\GIT\\..\\..\\etc', '/mnt'), 'D:\\GIT\\..\\..\\etc');
  assert.equal(windowsPathUnder('D:\\GIT', null), 'D:\\GIT');
});

test('R-GIT-WSL: UNC and drive-relative paths never resolve against the working directory', async t => {
  const f = await fixture(t);
  await f.session('\\\\server\\share\\project'); await f.session('D:project');
  const result = await analyzeMachineSessions({ ...f.options, windowsDriveRoot: join(f.root, 'mnt') });
  assert.ok(result.sessions.every(s => s.repositoryId === NO_REPOSITORY_ID));
});
