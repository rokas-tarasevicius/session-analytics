import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { captureSourceGeneration, changedSourceSessions, type SourceGeneration } from '../scripts/verify-real-source-changes.ts';
import { inspectOracleResults } from '../scripts/verify-real-results.ts';

const live = 'a'.repeat(12), settled = 'b'.repeat(12);
test('source evidence spans oracle collection, including late additions and timestamp-free child writes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'verify-source-changes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const claudeRoot = join(directory, 'claude'), codexRoot = join(directory, 'codex');
  const id = '10000000-0000-4000-8000-000000000001';
  const child = join(claudeRoot, id, 'subagents'); await mkdir(child, { recursive: true }); await mkdir(codexRoot);
  const source = join(child, 'agent-synthetic.jsonl'); await writeFile(source, '{}\n');
  const options = { claudeRoot, codexRoot, codexArchiveRoot: join(directory, 'absent'), databasePath: join(directory, 'missing.db') };
  const before = await captureSourceGeneration(directory, 'full-before', options);
  const afterScan = await captureSourceGeneration(directory, 'warm-after', options);
  assert.equal(changedSourceSessions([before, afterScan]).size, 0);
  await writeFile(source, '{"synthetic":"PRIVATE-SENTINEL"}\n');
  await writeFile(join(codexRoot, `${id}.jsonl`), '{}\n');
  const afterOracles = await captureSourceGeneration(directory, 'oracles-after', options);
  const key = (provider: string) => createHash('sha256').update(`${provider}:${id}`).digest('hex').slice(0, 12);
  assert.deepEqual([...changedSourceSessions([before, afterScan, afterOracles])].sort(), [key('claude'), key('codex')].sort());
  const persisted = await readFile(join(directory, 'sources-oracles-after.json'), 'utf8');
  for (const forbidden of [directory, id, 'PRIVATE-SENTINEL', 'agent-synthetic']) assert.equal(persisted.includes(forbidden), false);
});

test('source generations fail closed on absent, duplicate or malformed evidence', () => {
  const valid: SourceGeneration = { phase: 'before', capturedAt: '2026-10-01T00:00:00Z', sessions: [[live, 'c'.repeat(64)]] };
  assert.throws(() => changedSourceSessions([valid]));
  assert.throws(() => changedSourceSessions([valid, { ...valid, sessions: [...valid.sessions, ...valid.sessions] }]));
  assert.throws(() => changedSourceSessions([valid, { ...valid, sessions: [[live, 'invalid']] }]));
  assert.deepEqual([...changedSourceSessions([valid, { ...valid, sessions: [] }])], [live]);
});

test('registered aliases follow native changes and recovered registrations retain metadata evidence', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'verify-registered-changes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const claudeRoot = join(directory, 'claude'), codexRoot = join(directory, 'codex');
  await mkdir(claudeRoot); await mkdir(codexRoot);
  const nativeId = '20000000-0000-4000-8000-000000000002', databasePath = join(directory, 'synthetic.db');
  const source = join(claudeRoot, `${nativeId}.jsonl`); await writeFile(source, '{}\n');
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('CREATE TABLE repos(id TEXT); CREATE TABLE workspaces(id TEXT); CREATE TABLE sessions(id TEXT,claude_session_id TEXT,agent_type TEXT,status TEXT)');
    database.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('private-alias', nativeId, 'claude-code', 'completed');
    database.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('private-recovered', 'missing-native', 'claude', 'completed');
    const options = { claudeRoot, codexRoot, databasePath };
    const before = await captureSourceGeneration(directory, 'before', options);
    await writeFile(source, '{}\n{}\n');
    database.prepare('UPDATE sessions SET status=? WHERE id=?').run('active', 'private-recovered');
    const after = await captureSourceGeneration(directory, 'after', options);
    const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 12);
    assert.deepEqual([...changedSourceSessions([before, after])].sort(), [hash(`claude:${nativeId}`), hash('private-alias'), hash('private-recovered')].sort());
    const persisted = await readFile(join(directory, 'sources-after.json'), 'utf8');
    for (const forbidden of [directory, nativeId, 'private-alias', 'private-recovered']) assert.equal(persisted.includes(forbidden), false);
  } finally { database.close(); }
});

test('one changed-source set applies to every native gate without waiving snapshot or summary corruption', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'verify-live-gates-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const put = async (area: string, file: string, value: unknown) => {
    await mkdir(join(directory, area, '.lane'), { recursive: true });
    await writeFile(join(directory, area, '.lane', file), JSON.stringify(value));
  };
  await writeFile(join(directory, 'full.json'), JSON.stringify({ sessions: [] }));
  await put('claude', 'claude-oracle.json', { sessions: [{ sessionKey: live }], ignored: [] });
  await put('other-providers', 'desktop-audit-oracle.json', { intervals: [] });
  const codex = { differences: [], missing: [{ key: live }], unclassifiedDiscovery: [], excludedLive: [], retained: [],
    summary: { differences: 0, missing: 1, unclassifiedDiscovery: 0, live: 0, eligibleIdentities: 1, matched: 0 } };
  await put('codex', 'codex-current.json', codex);
  await put('conductor', 'conductor-current.json', { differences: [{ sessionKey: live }], unmatched: [] });
  await put('aggregation', 'snapshot-oracle-results.json', { mismatches: [{ sessionKey: live, field: 'cost.execution' }] });
  await put('repos', 'repos-oracle.json', { rows: [{ sessionKey: live, matches: false }, { sessionKey: settled, matches: false }], mismatches: { sessions: 2 }, missing: [] });
  await put('time', 'time-reference-audit.json', { parityErrors: [], discrepancies: [] });
  await mkdir(join(directory, 'dedup/.lane'), { recursive: true });
  const areas = ['claude', 'codex', 'conductor', 'dedup', 'aggregation', 'repos', 'time'];
  const results = await inspectOracleResults(directory, areas, undefined, new Set([live]));
  const checks = new Map(results.flatMap(r => r.checks.map(c => [c.check, c] as const)));
  for (const name of ['native-session-token-cost-model-day', 'current-independent-retained-native-events', 'independent-message-receipt-model-day-arithmetic',
    'current-native-and-desktop-identity-coverage', 'current-codex-retained-request-ownership', 'native-request-scope-and-complete-event-conservation',
    'independent-claude-utc-and-local-hour-events', 'independent-codex-utc-and-local-hour-events', 'independent-recovered-utc-and-local-hour-events']) {
    assert.equal(checks.get(name)?.differences, 0, name);
  }
  assert.equal(checks.get('session-repository-machine-reconciliation')?.differences, 1, 'Live sources never waive intrinsic arithmetic');
  assert.equal(checks.get('raw-repository-ownership')?.differences, 1, 'Stable sessions remain strict');
  assert.ok(results.every(r => r.area === 'aggregation' || r.liveExclusions.some(e => e.sessionKey === live)));
  await put('codex', 'codex-current.json', { ...codex, summary: { ...codex.summary, missing: 0 } });
  const invalid = (await inspectOracleResults(directory, ['codex'], undefined, new Set([live])))[0]!;
  assert.equal(invalid.checks[0]!.differences, 1, 'Live source exclusions do not repair inconsistent oracle counts');
  const strict = (await inspectOracleResults(directory, ['claude']))[0]!;
  assert.equal(strict.checks[0]!.differences, 1, 'Without source proof the same missing session fails');
});
