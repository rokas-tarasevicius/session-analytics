import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { analyzeMachineSessions, cursorSessions, type RepositoryRow } from '../../src/analyzer.ts';
import { validateSnapshot } from '../../src/interop/snapshot.ts';

const composerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const at = Date.parse('2026-08-19T12:00:00Z');
const bubble = { bubbleId: 'synthetic-bubble', type: 2, timingInfo: { clientStartTime: at, clientEndTime: at + 1000 }, tokenCount: { inputTokens: 100, outputTokens: 20 }, text: 'PRIVATE_CONTENT_SENTINEL', toolFormerData: { toolCallId: 'synthetic-tool-call', name: 'Read', input: 'PRIVATE_ARGUMENT_SENTINEL' } };
async function fixture(data: Record<string, unknown>, diskBubbles: unknown[] = [], malformedComposer = false) {
  const root = await mkdtemp(join(tmpdir(), 'cursor-native-validation-'));
  const path = join(root, 'state.vscdb');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE composerHeaders (composerId TEXT, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isSubagent INTEGER, value TEXT)');
  const insert = db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)');
  insert.run(`composerData:${composerId}`, JSON.stringify({ composerId, createdAt: at, lastUpdatedAt: at + 1000, isDraft: false, context: { folder: root }, ...data }));
  for (const [i, value] of diskBubbles.entries()) insert.run(`bubbleId:${composerId}:${i}`, JSON.stringify(value));
  if (malformedComposer) insert.run('composerData:synthetic-truncated', '{"composerId":');
  db.close();
  const repository: RepositoryRow = { id: 'synthetic-repository', name: 'Synthetic', root_path: root, remote_url: null, default_branch: '' };
  try {
    const result = await cursorSessions(path, [repository], new Map(), new Map());
    const absent = join(root, 'absent');
    const snapshot = validateSnapshot(await analyzeMachineSessions({ noIndex: true, additionalProviders: false, pricingPolicy: 'reviewed-only', databasePath: absent, cursorDatabasePath: path, claudeRoot: absent, codexRoot: absent, codexArchiveRoot: absent }));
    const output = JSON.stringify([result, snapshot]);
    for (const privateValue of [root, composerId, 'PRIVATE_CONTENT_SENTINEL', 'PRIVATE_ARGUMENT_SENTINEL', 'synthetic-bubble', 'synthetic-tool-call']) assert.ok(!output.includes(privateValue), 'private source field escaped');
    return result;
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('CURSOR-NATIVE-01: an empty draft is not an observed session', async () => {
  const result = await fixture({ isDraft: true, usageData: {}, conversation: [], totalLinesAdded: 0, totalLinesRemoved: 0 });
  assert.equal(result.sessions.length, 0);
});

test('CURSOR-NATIVE-02: unavailable provider cost cannot be marked complete', async () => {
  const result = await fixture({ conversation: [bubble], usageData: {} });
  assert.equal(result.sessions[0]!.costBasis, 'unavailable');
  assert.equal(result.sessions[0]!.costComplete, false);
});

test('CURSOR-NATIVE-03: an explicit zero provider cost remains reported evidence', async () => {
  const result = await fixture({ conversation: [bubble], usageData: { 'synthetic-model': { costInCents: 0 } } });
  assert.equal(result.sessions[0]!.cost.totalUsd, 0);
  assert.equal(result.sessions[0]!.costBasis, 'provider-reported');
  assert.equal(result.sessions[0]!.costComplete, true);
  assert.equal(result.sessions[0]!.models[0]?.model, 'synthetic-model');
});

test('CURSOR-NATIVE-04: migrated disk bubbles supersede stale inline snapshots', async () => {
  const result = await fixture({ conversation: [{ ...bubble, timingInfo: { clientStartTime: at, clientEndTime: at + 10 }, tokenCount: { inputTokens: 10, outputTokens: 2 } }] }, [bubble]);
  assert.equal(result.sessions[0]!.tokens.inputTokens, 100);
  assert.equal(result.sessions[0]!.tokens.outputTokens, 20);
  assert.equal(result.sessions[0]!.metrics.assistantMessages, 1);
  assert.equal(result.sessions[0]!.metrics.toolCalls, 1);
});

test('CURSOR-NATIVE-05: repeated inline bubble identity contributes once', async () => {
  const result = await fixture({ conversation: [bubble, bubble] });
  assert.equal(result.sessions[0]!.tokens.inputTokens, 100);
  assert.equal(result.sessions[0]!.metrics.assistantMessages, 1);
  assert.equal(result.sessions[0]!.metrics.modelCalls, 1);
});

test('CURSOR-NATIVE-06: corrupt composer rows mark a partial read while retaining valid sessions', async () => {
  const result = await fixture({ conversation: [bubble] }, [], true);
  assert.equal(result.sessions.length, 1);
  assert.notEqual(result.warning, null);
});
