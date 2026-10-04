import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { captureSupportedInventory, inventoryMemberKey, verifyInventorySnapshot, type InventoryCensus } from '../scripts/verify-real-inventory.ts';

const rootId = 'discovered-0123456789abcdef0123';
const snapshot = (census: InventoryCensus, members = census.members) => ({ generatedAt: census.capturedAt, repositories: [{ repository: { id: rootId } }],
  workflow: { installedSkills: members.map(({ name, provider, repositoryId }) => ({ name, provider, repositoryId, observedInvocations: 0 })) } });
const install = async (path: string) => { await mkdir(path, { recursive: true }); await writeFile(join(path, 'SKILL.md'), 'PRIVATE_SKILL_BODY_SENTINEL'); };

test('independent inventory captures system and symlink installations without reading bodies or publishing paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'private-inventory-'));
  try {
    const skills = join(root, 'skills'), linked = join(root, 'private-target');
    await install(join(skills, 'ordinary'));
    await install(join(skills, '.system', 'built-in'));
    await install(join(skills, 'nested', 'must-not-recurse'));
    await install(linked); await symlink(linked, join(skills, 'linked'));
    await chmod(join(skills, 'ordinary', 'SKILL.md'), 0);
    const roots = [{ path: skills, provider: 'codex' as const, repositoryId: rootId }];
    const before = await captureSupportedInventory(roots), after = await captureSupportedInventory(roots);
    assert.deepEqual(before.failures, []); assert.deepEqual(after.failures, []);
    assert.deepEqual(before.members.map(s => s.name).sort(), ['built-in', 'linked', 'ordinary']);
    assert.deepEqual(before.scopes.map(s => s.generation), after.scopes.map(s => s.generation));
    assert.equal(before.members.every(s => /^[a-f0-9]{64}$/.test(s.key) && s.key === inventoryMemberKey(s)), true);
    const proof = verifyInventorySnapshot(snapshot(after), [before, after]);
    assert.deepEqual(proof.failures, []); assert.equal(proof.memberKeys.length, 3);
    assert.doesNotMatch(JSON.stringify({ before, after, proof }), /PRIVATE_SKILL_BODY_SENTINEL|private-target|SKILL\.md|private-inventory-/);
    assert.equal(JSON.stringify(before).includes(root), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('only captured membership transitions within changed scopes admit a live installation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inventory-transition-'));
  try {
    const skills = join(root, 'skills'); await install(join(skills, 'stable'));
    const roots = [{ path: skills, provider: 'codex' as const, repositoryId: rootId }];
    const before = await captureSupportedInventory(roots);
    await install(join(skills, 'new-installation'));
    const after = await captureSupportedInventory(roots), current = snapshot(after);
    const proof = verifyInventorySnapshot(current, [before, after]);
    assert.deepEqual(proof.failures, []); assert.equal(proof.liveMemberKeys.length, 1);
    const missing = snapshot(after, after.members.filter(s => s.name !== 'stable'));
    assert.ok(verifyInventorySnapshot(missing, [before, after]).failures.some(s => s.startsWith('workflow.inventory.missing:')));
    const invented = structuredClone(current);
    invented.workflow.installedSkills.push({ name: 'unobserved', provider: 'codex', repositoryId: rootId, observedInvocations: 0 });
    assert.ok(verifyInventorySnapshot(invented, [before, after]).failures.some(s => s.startsWith('workflow.inventory.unobserved:')));
    const sameGeneration = structuredClone(after); sameGeneration.scopes = structuredClone(before.scopes);
    assert.ok(verifyInventorySnapshot(current, [before, sameGeneration]).failures.some(s => s.startsWith('workflow.inventory.unproved-transition:')));
    const duplicate = structuredClone(current); duplicate.workflow.installedSkills.push(duplicate.workflow.installedSkills[0]!);
    assert.deepEqual(verifyInventorySnapshot(duplicate, [before, after]).failures, ['workflow.inventory.evidence']);
    const duplicateEvidence = structuredClone(after); duplicateEvidence.members.push(duplicateEvidence.members[0]!);
    assert.deepEqual(verifyInventorySnapshot(current, [before, duplicateEvidence]).failures, ['workflow.inventory.evidence']);
    const future = { ...current, generatedAt: '2099-01-01T00:00:00.000Z' };
    assert.deepEqual(verifyInventorySnapshot(future, [before, after]).failures, ['workflow.inventory.evidence']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('unreadable installation markers fail instead of being treated as absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inventory-unavailable-')), skills = join(root, 'skills'), installation = join(skills, 'blocked');
  try {
    await install(installation); await chmod(installation, 0);
    const census = await captureSupportedInventory([{ path: skills, provider: 'codex', repositoryId: rootId }]);
    assert.ok(census.failures.some(s => s.endsWith(':marker-unavailable')));
    assert.deepEqual(verifyInventorySnapshot(snapshot(census), [census, census]).failures, ['workflow.inventory.evidence']);
  } finally { await chmod(installation, 0o700); await rm(root, { recursive: true, force: true }); }
});

test('ambiguous physical clones require independently equal skill sets instead of an invented union', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inventory-alternatives-'));
  try {
    const a = join(root, 'clone-a', 'skills'), b = join(root, 'clone-b', 'skills');
    await install(join(a, 'common')); await install(join(b, 'common'));
    const alternatives = [{ repositoryId: rootId, candidates: [
      [{ path: a, provider: 'codex' as const, repositoryId: rootId }],
      [{ path: b, provider: 'codex' as const, repositoryId: rootId }],
    ] }];
    const before = await captureSupportedInventory([], alternatives), after = await captureSupportedInventory([], alternatives);
    assert.deepEqual(before.failures, []); assert.equal(before.members.length, 1); assert.equal(before.members[0]!.sourceKeys.length, 2);
    assert.deepEqual(verifyInventorySnapshot(snapshot(after), [before, after]).failures, []);
    await install(join(b, 'only-one-clone'));
    const divergent = await captureSupportedInventory([], alternatives);
    assert.ok(divergent.failures.some(s => s.endsWith(':ambiguous-membership')));
    assert.equal(divergent.members.length, 0, 'divergent sets are not unioned or selected by actual snapshot values');
    assert.deepEqual(verifyInventorySnapshot(snapshot(divergent), [before, divergent]).failures, ['workflow.inventory.evidence']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('truncated or malformed empty-scope observations cannot pass recheck through undefined equality', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inventory-shape-'));
  try {
    const census = await captureSupportedInventory([{ path: join(root, 'absent'), provider: 'codex', repositoryId: rootId }]);
    assert.equal(census.members.length, 0);
    assert.deepEqual(verifyInventorySnapshot(snapshot(census), [census, census]).failures, []);
    for (const [field, value] of [
      ['generation', undefined], ['generation', 'not-a-digest'], ['generation', 1],
      ['key', undefined], ['key', 'a'.repeat(63)], ['status', undefined], ['status', 'unknown'],
      ['provider', undefined], ['provider', 'other'], ['repositoryId', undefined], ['repositoryId', 1],
    ] as const) {
      const malformed = structuredClone(census);
      (malformed.scopes[0]! as unknown as Record<string, unknown>)[field] = value;
      assert.deepEqual(verifyInventorySnapshot(snapshot(census), [malformed, malformed]).failures, ['workflow.inventory.evidence'], `${field}:${String(value)}`);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
