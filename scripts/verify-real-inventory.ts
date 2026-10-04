/** Independent supported skill inventory census. Paths remain in memory; only
 * public names, pseudonymous scopes and metadata-generation digests are returned. */
import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

type Provider = 'claude' | 'codex';
export interface InventoryRoot { path: string; provider: Provider; repositoryId: string | null }
export interface InventoryAlternative { repositoryId: string; candidates: readonly (readonly InventoryRoot[])[] }
export interface SkillMetadata { name: string; provider: Provider; repositoryId: string | null }
export interface InventoryMember extends SkillMetadata { key: string; generation: string; sourceKeys: string[] }
export interface InventoryCensus {
  capturedAt: string;
  scopes: Array<{ key: string; provider: Provider; repositoryId: string | null; generation: string; status: 'read' | 'absent' }>;
  members: InventoryMember[];
  failures: string[];
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const inventoryMemberKey = (value: SkillMetadata) => digest([value.provider, value.repositoryId, value.name]);
const validName = (name: string) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(name);
const version = (s: BigIntStats) => [String(s.dev), String(s.ino), String(s.size), String(s.mtimeNs), String(s.ctimeNs), s.isFile(), s.isDirectory(), s.isSymbolicLink()];
const fileMetadata = (path: string) => stat(path, { bigint: true });
const linkMetadata = (path: string) => lstat(path, { bigint: true });
const absent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

/** Supports direct skill directories, symlink installations and the one
 * documented .system subtree. It never opens a SKILL.md body or follows other
 * nested directories. Inaccessible evidence and an in-census race fail closed. */
export async function captureSupportedInventory(roots: readonly InventoryRoot[], alternatives: readonly InventoryAlternative[] = []): Promise<InventoryCensus> {
  const capturedAt = new Date().toISOString(), scopes: InventoryCensus['scopes'] = [], failures: string[] = [];
  const members = new Map<string, { metadata: SkillMetadata; sources: Map<string, string> }>();
  const seenRequested = new Set<string>();
  const walk = async (root: InventoryRoot, ancestors = new Set<string>()): Promise<void> => {
    const key = digest([root.provider, root.repositoryId, resolve(root.path)]);
    if (seenRequested.has(key)) return;
    seenRequested.add(key);
    let canonical: string, before: BigIntStats, linkBefore: BigIntStats;
    try { canonical = await realpath(root.path); before = await fileMetadata(root.path); linkBefore = await linkMetadata(root.path); }
    catch (error) {
      if (absent(error)) scopes.push({ key, provider: root.provider, repositoryId: root.repositoryId, generation: digest(['absent']), status: 'absent' });
      else failures.push(`scope:${key}:unavailable`);
      return;
    }
    if (!before.isDirectory() || ancestors.has(canonical)) { failures.push(`scope:${key}:invalid`); return; }
    const nextAncestors = new Set([...ancestors, canonical]);
    const observations: unknown[] = [];
    try {
      const entries = (await readdir(root.path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        observations.push([entry.name, entry.isDirectory(), entry.isSymbolicLink()]);
        if (entry.name === '.system' && entry.isDirectory()) { await walk({ ...root, path: join(root.path, entry.name) }, nextAncestors); continue; }
        if (!validName(entry.name) || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
        const installation = join(root.path, entry.name), marker = join(installation, 'SKILL.md');
        try {
          const installBefore = await linkMetadata(installation), markerBefore = await fileMetadata(marker);
          const markerLinkBefore = await linkMetadata(marker), canonicalMarker = await realpath(marker);
          const markerAfter = await fileMetadata(marker), markerLinkAfter = await linkMetadata(marker), installAfter = await linkMetadata(installation);
          if (digest([version(installBefore), version(markerBefore), version(markerLinkBefore)]) !== digest([version(installAfter), version(markerAfter), version(markerLinkAfter)])) {
            failures.push(`scope:${key}:changed-during-read`); continue;
          }
          observations.push([entry.name, version(installBefore), version(markerBefore), version(markerLinkBefore), digest(canonicalMarker)]);
          if (!markerBefore.isFile()) continue;
          const metadata = { name: entry.name, provider: root.provider, repositoryId: root.repositoryId }, memberKey = inventoryMemberKey(metadata);
          const member = members.get(memberKey) ?? { metadata, sources: new Map<string, string>() };
          member.sources.set(key, digest([canonicalMarker, version(installBefore), version(markerBefore), version(markerLinkBefore)])); members.set(memberKey, member);
        } catch (error) {
          if (absent(error)) observations.push([entry.name, 'marker-absent']);
          else failures.push(`scope:${key}:marker-unavailable`);
        }
      }
      const after = await fileMetadata(root.path), linkAfter = await linkMetadata(root.path);
      if (canonical !== await realpath(root.path) || digest([version(before), version(linkBefore)]) !== digest([version(after), version(linkAfter)])) failures.push(`scope:${key}:changed-during-read`);
      scopes.push({ key, provider: root.provider, repositoryId: root.repositoryId, generation: digest([canonical, version(before), version(linkBefore), observations]), status: 'read' });
    } catch { failures.push(`scope:${key}:unavailable`); }
  };
  for (const root of roots) await walk(root);
  const alternativeIds = new Set<string>();
  for (const group of alternatives) {
    const groupKey = digest(group.repositoryId);
    if (alternativeIds.has(group.repositoryId) || roots.some(root => root.repositoryId === group.repositoryId) || group.candidates.length < 2 || group.candidates.some(candidate => !candidate.length || candidate.some(root => root.repositoryId !== group.repositoryId))) {
      failures.push(`repository:${groupKey}:invalid-alternatives`); continue;
    }
    alternativeIds.add(group.repositoryId);
    const captures: InventoryCensus[] = [];
    for (const candidate of group.candidates) captures.push(await captureSupportedInventory(candidate));
    const keys = (c: InventoryCensus) => c.members.map(m => m.key).sort().join(':');
    if (captures.some(c => c.failures.length || keys(c) !== keys(captures[0]!))) {
      failures.push(`repository:${groupKey}:ambiguous-membership`); continue;
    }
    // Different clones of one logical repository need no guessed physical owner
    // when every candidate independently exposes exactly the same skill set.
    for (const capture of captures) {
      for (const scope of capture.scopes) {
        const previous = scopes.find(s => s.key === scope.key);
        if (previous && previous.generation !== scope.generation) failures.push(`scope:${scope.key}:changed-during-read`);
        else if (!previous) scopes.push(scope);
      }
      for (const member of capture.members) {
        const accumulated = members.get(member.key) ?? { metadata: { name: member.name, provider: member.provider, repositoryId: member.repositoryId }, sources: new Map<string, string>() };
        for (const sourceKey of member.sourceKeys) accumulated.sources.set(sourceKey, member.generation);
        members.set(member.key, accumulated);
      }
    }
  }
  return { capturedAt, scopes: scopes.sort((a, b) => a.key.localeCompare(b.key)), members: [...members].map(([key, { metadata, sources }]) => ({ ...metadata, key,
    generation: digest([...sources].sort(([a], [b]) => a.localeCompare(b))), sourceKeys: [...sources.keys()].sort() })).sort((a, b) => a.key.localeCompare(b.key)), failures: [...new Set(failures)].sort() };
}

export interface InventorySnapshotProof { failures: string[]; liveMemberKeys: string[]; memberKeys: string[]; scopeKeys: string[] }
const validDigest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validRepositoryId = (value: unknown): value is string | null => value === null || typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
/** Shape validation is also required on the complete stored capture before any
 * out-of-scope failures are projected away. Only that caller may allow typed
 * failure strings; malformed observations are never made valid by scoping. */
export function validInventoryCensus(census: InventoryCensus, allowFailures = false): boolean {
  if (!census || typeof census !== 'object' || typeof census.capturedAt !== 'string' || !Number.isFinite(Date.parse(census.capturedAt)) ||
    !Array.isArray(census.failures) || !census.failures.every(failure => typeof failure === 'string') || !allowFailures && census.failures.length > 0 ||
    !Array.isArray(census.scopes) || !Array.isArray(census.members)) return false;
  if (!census.scopes.every(scope => scope && typeof scope === 'object' && validDigest(scope.key) && validDigest(scope.generation) &&
    (scope.status === 'read' || scope.status === 'absent') && (scope.provider === 'claude' || scope.provider === 'codex') && validRepositoryId(scope.repositoryId))) return false;
  const scopes = new Map(census.scopes.map(scope => [scope.key, scope]));
  if (scopes.size !== census.scopes.length) return false;
  return census.members.every(member => member && typeof member === 'object' && validDigest(member.key) && validDigest(member.generation) &&
    typeof member.name === 'string' && validName(member.name) && (member.provider === 'claude' || member.provider === 'codex') && validRepositoryId(member.repositoryId) &&
    member.key === inventoryMemberKey(member) && Array.isArray(member.sourceKeys) && member.sourceKeys.length > 0 && new Set(member.sourceKeys).size === member.sourceKeys.length &&
    member.sourceKeys.every(key => validDigest(key) && scopes.get(key)?.status === 'read' && scopes.get(key)?.provider === member.provider && scopes.get(key)?.repositoryId === member.repositoryId));
}
/** Capture pairs bind inventory to the same bounded observation window as the
 * analyzer phase. Stable members are mandatory; only independently observed
 * before/after membership transitions can be optional within a changing scope. */
export function verifyInventorySnapshot(snapshot: Record<string, any>, pair: readonly [InventoryCensus, InventoryCensus]): InventorySnapshotProof {
  const failures: string[] = [], result = { failures, liveMemberKeys: [] as string[], memberKeys: [] as string[], scopeKeys: [] as string[] };
  const invalid = () => { failures.push('workflow.inventory.evidence'); return result; };
  try {
    const [before, after] = pair;
    if (!validInventoryCensus(before) || !validInventoryCensus(after)) return invalid();
    const start = Date.parse(before.capturedAt), end = Date.parse(after.capturedAt), generated = Date.parse(snapshot.generatedAt);
    if (![start, end, generated].every(Number.isFinite) || start > generated || generated > end) return invalid();
    const repositoryIds = new Set<string>(snapshot.repositories.map((r: any) => r.repository.id));
    const inScope = (row: { repositoryId: string | null }) => row.repositoryId === null || repositoryIds.has(row.repositoryId);
    const scopeMap = (c: InventoryCensus) => new Map(c.scopes.filter(inScope).map(s => [s.key, s]));
    const oldScopes = scopeMap(before), newScopes = scopeMap(after);
    if (oldScopes.size !== before.scopes.filter(inScope).length || newScopes.size !== after.scopes.filter(inScope).length) return invalid();
    // Scope discovery changes cannot silently remove an inventory root.
    if ([...oldScopes.keys()].some(k => !newScopes.has(k)) || [...newScopes.keys()].some(k => !oldScopes.has(k))) return invalid();
    const changed = new Set([...oldScopes].filter(([key, value]) => value.generation !== newScopes.get(key)!.generation).map(([key]) => key));
    const metadata = (c: InventoryCensus) => new Map(c.members.filter(inScope).map(m => [m.key, m]));
    const old = metadata(before), current = metadata(after);
    if (old.size !== before.members.filter(inScope).length || current.size !== after.members.filter(inScope).length) return invalid();
    for (const [key, member] of [...old, ...current]) {
      if (!/^[a-f0-9]{64}$/.test(key) || key !== inventoryMemberKey(member) || !validName(member.name) || !['claude', 'codex'].includes(member.provider) || !member.sourceKeys.length || member.sourceKeys.some(k => !oldScopes.has(k))) return invalid();
    }
    const actual = new Map<string, SkillMetadata>();
    for (const row of snapshot.workflow.installedSkills) {
      if (!validName(row.name) || !['claude', 'codex'].includes(row.provider) || !(row.repositoryId === null || repositoryIds.has(row.repositoryId))) return invalid();
      const key = inventoryMemberKey(row); if (actual.has(key)) return invalid(); actual.set(key, row);
    }
    for (const key of new Set([...old.keys(), ...current.keys(), ...actual.keys()])) {
      const a = old.get(key), b = current.get(key), present = actual.has(key);
      if (!a && !b) { failures.push(`workflow.inventory.unobserved:${key}`); continue; }
      if (a && b) { if (!present) failures.push(`workflow.inventory.missing:${key}`); continue; }
      const member = a ?? b!;
      if (!member.sourceKeys.some(k => changed.has(k))) { failures.push(`workflow.inventory.unproved-transition:${key}`); continue; }
      result.liveMemberKeys.push(key);
    }
    result.memberKeys = [...actual.keys()].sort(); result.scopeKeys = [...oldScopes.keys()].sort(); result.liveMemberKeys.sort();
  } catch { return invalid(); }
  return result;
}
