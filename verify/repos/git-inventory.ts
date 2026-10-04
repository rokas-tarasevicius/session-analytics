// Independent, bounded Git/Conductor reference diff; only hashes and counters leave memory.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConductor } from './conductor-oracle.ts';
import { resolveRepository, hash } from './git-oracle.ts';

const data = loadConductor(homedir());
const snapshot = JSON.parse(readFileSync(join(homedir(), 'session-analytics-lanes/reference/snapshot-noindex-51ea561.json'), 'utf8'));
const referenceIds = new Set(snapshot.repositories.map((r: any) => r.repository.id));
const documentedId = (id: string) => `conductor-${createHash('sha256').update(id).digest('hex').slice(0, 20)}`;
// After the initial 0/34 mismatch, source inspection proved a missing domain prefix in docs.
const publicId = (id: string) => `conductor-${createHash('sha256').update(`conductor:${id}`).digest('hex').slice(0, 20)}`;
const groups = new Map<string, string[]>();
const rows = data.repos.map(repo => {
  const resolved = resolveRepository(repo.root_path, repo.remote_url);
  const ids = groups.get(resolved.identity) ?? [];
  ids.push(publicId(repo.id)); groups.set(resolved.identity, ids);
  return { repositoryKey: hash(repo.id), referenceIdPresent: referenceIds.has(publicId(repo.id)), confidence: resolved.confidence, metadataDisagrees: resolved.metadataDisagrees };
});
const splitGroups = [...groups.values()].filter(ids => ids.length > 1).map(ids => {
  const sessions = snapshot.sessions.filter((s: any) => ids.includes(s.repositoryId) && (!s.lastEventAt || s.lastEventAt <= snapshot.generatedAt));
  return { repositoryKeys: ids, snapshotRows: ids.filter(id => referenceIds.has(id)).length, sessions: sessions.length,
    cost: sessions.reduce((sum: number, s: any) => sum + s.cost.totalUsd, 0),
    tokens: sessions.reduce((sum: number, s: any) => sum + s.tokens.inputTokens + s.tokens.outputTokens, 0) };
});
const result = { checkedRepositories: rows.length, documentedIdMatches: data.repos.filter(r => referenceIds.has(documentedId(r.id))).length, referenceMatches: rows.filter(r => r.referenceIdPresent).length, gitConfidence: rows.filter(r => r.confidence === 'filesystem').length, metadataDisagreements: rows.filter(r => r.metadataDisagrees).length, splitGroups };
writeFileSync('.lane/git-inventory.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
