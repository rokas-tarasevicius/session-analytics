import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalizeRemote, localDirectoryAttribution, resolveRepository } from './git-oracle.ts';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'repos-oracle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function repo(root: string, remote: string | null = 'https://example.test/team/project.git') {
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.git/config'), remote ? `[remote "origin"]\n url = ${remote}\n` : '[core]\n bare = false\n');
}

test('oracle groups existing, deleted and symlinked OS temporary directories without swallowing Git identities', t => {
  const root = realpathSync(fixture(t)), nested = join(root, 'existing'); mkdirSync(nested);
  const alias = join(root, 'alias'); symlinkSync(nested, alias);
  const ephemeral = '/private/var/folders/session-analytics-ephemeral';
  for (const cwd of [root, nested, alias, join(root, 'deleted'), '/tmp/synthetic-deleted-session', '/private/var/folders/xx/synthetic/T/deleted']) {
    assert.deepEqual(localDirectoryAttribution(cwd, resolveRepository(cwd)), { root: ephemeral, route: 'ephemeral' });
  }
  for (const cwd of ['/tmp-neighbor/synthetic', '/opt/synthetic-local', '/var/synthetic-deleted-session', '/var/folders/xx/synthetic/T/deleted', '/private/tmp/synthetic-deleted-session']) {
    assert.deepEqual(localDirectoryAttribution(cwd, resolveRepository(cwd)), { root: cwd, route: 'local-directory' });
  }
  const checkout = join(root, 'checkout'); repo(checkout);
  assert.equal(localDirectoryAttribution(checkout, resolveRepository(checkout)).route, 'local-directory');
  assert.equal(localDirectoryAttribution(join(root, 'gone'), resolveRepository(join(root, 'gone'), 'https://example.test/team/project.git')).route, 'local-directory');
});

test('oracle canonicalizes equivalent SSH, SCP, HTTPS and git protocol remotes', () => {
  for (const value of ['git@example.test:team/project.git', 'ssh://git@example.test/team/project.git', 'https://user:secret@example.test/team/project.git/', 'http://example.test/team/project', 'git://example.test/team/project.git']) {
    assert.equal(canonicalizeRemote(value), 'example.test/team/project');
  }
});
test('oracle keeps repository namespace, host, custom ports and arbitrary-host case', () => {
  assert.notEqual(canonicalizeRemote('https://one.test/team/project'), canonicalizeRemote('https://two.test/team/project'));
  assert.notEqual(canonicalizeRemote('https://one.test/team/project'), canonicalizeRemote('https://one.test/other/project'));
  assert.notEqual(canonicalizeRemote('ssh://one.test:2222/team/project'), canonicalizeRemote('ssh://one.test/team/project'));
  assert.notEqual(canonicalizeRemote('ssh://one.test/Team/project'), canonicalizeRemote('ssh://one.test/team/project'));
  assert.equal(canonicalizeRemote('ssh://git@github.com:22/Team/Project.git'), 'github.com/team/project');
});
test('oracle excludes credentials, query and fragments from URL identity', () => {
  assert.equal(canonicalizeRemote('https://private:secret@example.test/team/project.git?token=secret#secret'), 'example.test/team/project');
  assert.equal(canonicalizeRemote('not a remote'), null);
});
test('oracle picks nearest nested repo instead of its ancestor', t => {
  const root = fixture(t); repo(root); repo(join(root, 'nested'), 'git@other.test:owner/project.git');
  mkdirSync(join(root, 'nested/src'), { recursive: true });
  assert.equal(resolveRepository(join(root, 'nested/src')).remote, 'other.test/owner/project');
});
test('oracle follows symlink aliases and parent folders', t => {
  const root = fixture(t); repo(join(root, 'actual')); mkdirSync(join(root, 'actual/src'));
  symlinkSync(join(root, 'actual'), join(root, 'alias'));
  assert.equal(resolveRepository(join(root, 'alias/src')).identity, resolveRepository(join(root, 'actual')).identity);
});
test('oracle links worktrees via .git pointer and commondir', t => {
  const root = fixture(t); repo(join(root, 'main')); mkdirSync(join(root, 'main/.git/worktrees/branch'), { recursive: true });
  mkdirSync(join(root, 'tree'));
  writeFileSync(join(root, 'tree/.git'), 'gitdir: ../main/.git/worktrees/branch\n');
  writeFileSync(join(root, 'main/.git/worktrees/branch/commondir'), '../..\n');
  assert.equal(resolveRepository(join(root, 'tree')).identity, resolveRepository(join(root, 'main')).identity);
  assert.ok(resolveRepository(join(root, 'tree')).evidence.includes('commondir'));
});
test('oracle metadata recovers removed checkout and broken worktree target', t => {
  const root = fixture(t); mkdirSync(join(root, 'tree'));
  writeFileSync(join(root, 'tree/.git'), 'gitdir: ../removed/.git/worktrees/branch\n');
  for (const cwd of [join(root, 'tree'), join(root, 'removed/src')]) {
    assert.equal(resolveRepository(cwd, 'git@example.test:team/project.git').identity, 'remote:example.test/team/project');
    assert.equal(resolveRepository(cwd, 'git@example.test:team/project.git').confidence, 'metadata');
  }
});
test('oracle removed nested checkout prefers historical remote over surviving outer repo', t => {
  const root = fixture(t); repo(root);
  const result = resolveRepository(join(root, 'removed/src'), 'git@other.test:owner/project.git');
  assert.equal(result.remote, 'other.test/owner/project');
  assert.equal(result.metadataDisagrees, true);
});
test('oracle no Git repo remains unresolved without metadata', t => {
  const root = fixture(t);
  assert.equal(resolveRepository(root).confidence, 'unresolved');
  assert.equal(resolveRepository(root, 'git@example.test:team/project.git').confidence, 'metadata');
});
test('oracle same remote cloned in different directories has one identity', t => {
  const root = fixture(t); repo(join(root, 'one')); repo(join(root, 'two'), 'git@example.test:team/project.git');
  assert.equal(resolveRepository(join(root, 'one')).identity, resolveRepository(join(root, 'two')).identity);
});
test('oracle no-remote worktrees share common Git identity', t => {
  const root = fixture(t); repo(join(root, 'main'), null); mkdirSync(join(root, 'main/.git/worktrees/branch'), { recursive: true });
  mkdirSync(join(root, 'tree')); writeFileSync(join(root, 'tree/.git'), 'gitdir: ../main/.git/worktrees/branch\n');
  writeFileSync(join(root, 'main/.git/worktrees/branch/commondir'), '../..\n');
  assert.equal(resolveRepository(join(root, 'tree')).identity, resolveRepository(join(root, 'main')).identity);
});
test('oracle broken nested Git marker does not attribute to enclosing repo', t => {
  const root = fixture(t); repo(root); mkdirSync(join(root, 'inner'));
  writeFileSync(join(root, 'inner/.git'), 'unreadable git marker\n');
  const result = resolveRepository(join(root, 'inner'));
  assert.equal(result.confidence, 'unresolved'); assert.equal(result.remote, null);
});
