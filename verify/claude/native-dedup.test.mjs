import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 12);
const tokens = (input, output) => ({ inputTokens: input, uncachedInputTokens: input, cachedInputTokens: 0,
  cacheWriteInputTokens: 0, cacheWrite5mInputTokens: 0, cacheWrite1hInputTokens: 0,
  outputTokens: output, reasoningOutputTokens: 0, nonReasoningOutputTokens: 0 });

test('independent Claude oracle deduplicates message snapshots and copies without collapsing distinct messages in one request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-native-oracle-'));
  try {
    const home = join(root, 'home'), projects = join(home, '.claude/projects/synthetic'), snapshotPath = join(root, 'snapshot.json');
    const dbPath = join(home, 'Library/Application Support/com.conductor.app/conductor.db');
    await mkdir(projects, { recursive: true }); await mkdir(join(root, '.lane')); await mkdir(join(root, 'prices'));
    await mkdir(join(home, 'Library/Application Support/com.conductor.app'), { recursive: true });
    const db = new DatabaseSync(dbPath); db.exec('CREATE TABLE sessions(id TEXT,claude_session_id TEXT,agent_type TEXT)'); db.close();
    await writeFile(join(root, '.lane/claude-key-aliases.json'), '{}');
    const a = 'a0000000-0000-4000-8000-000000000001', b = 'b0000000-0000-4000-8000-000000000002';
    const message = (sessionId, id, input, output, timestamp, extra = {}) => ({ type: 'assistant', sessionId, cwd: root,
      timestamp, requestId: 'shared-request', message: { id, model: 'unpriced-model', usage: { input_tokens: input, output_tokens: output },
        content: [{ type: 'text', text: 'PRIVATE_CLAUDE_ORACLE_SENTINEL' }] }, ...extra });
    const start = '2026-09-30T23:00:00Z', end = '2026-10-01T00:01:00Z';
    const rows = [
      [a, [message(a, 'response-one', 10, 1, start), null, false, 'invalid-record', [], message(a, 'response-one', 10, 5, end),
        message(a, 'response-one', 10, 5, end), message(a, 'response-two', 7, 3, end),
        message(a, 'failed-response', 999, 999, end, { isApiErrorMessage: true })]],
      [b, [message(b, 'response-one', 10, 5, end), message(b, 'response-three', 4, 2, end)]],
    ];
    for (const [id, records] of rows) await writeFile(join(projects, `${id}.jsonl`), records.map(row => JSON.stringify(row)).join('\n') + '\n');
    const session = (id, input, output, calls) => ({ sessionKey: hash(`claude:${id}`), provider: 'claude', tokens: tokens(input, output),
      cost: { totalUsd: 0 }, models: [{ model: 'unpriced-model', ...tokens(input, output), totalUsd: 0, calls }],
      metrics: { modelCalls: calls, compactions: 0 }, spendByDay: {}, repositoryId: 'synthetic' });
    const snapshot = { generatedAt: '2026-10-02T00:00:00Z', velocity: { timeZone: 'UTC' }, rateCard: { pricing: { policy: 'reviewed-only', sources: [] } }, sessions: [session(a, 17, 8, 2), session(b, 4, 2, 1)] };
    await writeFile(snapshotPath, JSON.stringify(snapshot));
    const run = async () => {
      const result = spawnSync(process.execPath, ['--import', fileURLToPath(new URL('../../scripts/verify-reference.mjs', import.meta.url)),
        fileURLToPath(new URL('./oracle.mjs', import.meta.url))], { cwd: root, encoding: 'utf8',
        env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), SESSION_ANALYTICS_VERIFY_REFERENCE: snapshotPath, CLAUDE_ORACLE_PRICING_DIR: join(root, 'prices') } });
      assert.equal(result.status, 0, result.stderr);
      const text = await readFile(join(root, '.lane/claude-oracle.json'), 'utf8');
      assert.doesNotMatch(text, /PRIVATE_CLAUDE_ORACLE_SENTINEL/);
      return JSON.parse(text);
    };
    const report = await run();
    assert.equal(report.observations.malformed, 4);
    assert.deepEqual(report.diffs, []);
    assert.equal(report.sessions.reduce((n, row) => n + row.calls, 0), 3);
    assert.equal(report.sessions.reduce((n, row) => n + row.tokens.inputTokens, 0), 21);
    assert.equal(report.sessions.find(row => row.sessionKey === hash(`claude:${a}`)).eventBuckets.find(row => row.inputTokens === 10).day, '2026-09-30', 'the first positive stream snapshot owns the request date');
    snapshot.sessions[0].tokens.inputTokens++;
    await writeFile(snapshotPath, JSON.stringify(snapshot));
    assert.ok((await run()).diffs.some(row => row.sessionKey === hash(`claude:${a}`) && row.deltaTokens.inputTokens === 1));
  } finally { await rm(root, { recursive: true, force: true }); }
});
