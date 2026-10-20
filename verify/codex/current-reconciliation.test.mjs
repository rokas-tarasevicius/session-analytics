import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 12);
const model = 'unpriced-model';
const cost = { inputUsd: 0, cachedInputUsd: 0, cacheWriteUsd: 0, outputUsd: 0, totalUsd: 0, upperEstimateUsd: 0 };
const usage = (input, output, reasoning) => ({ input_tokens: input, cached_input_tokens: 0, output_tokens: output, reasoning_output_tokens: reasoning });
const stamp = time => `2026-09-30T${time}Z`;
const record = (time, type, payload) => ({ timestamp: stamp(time), type, payload });
const count = (time, total, last) => record(time, 'event_msg', { type: 'token_count', info: { total_token_usage: total, ...(last ? { last_token_usage: last } : {}) } });
function session(id, input, output, reasoning) {
  const tokens = { inputTokens: input, uncachedInputTokens: input, cachedInputTokens: 0, cacheWriteInputTokens: 0,
    cacheWrite5mInputTokens: 0, cacheWrite1hInputTokens: 0, outputTokens: output, reasoningOutputTokens: reasoning, nonReasoningOutputTokens: output - reasoning };
  return { sessionKey: hash(`codex:${id}`), provider: 'codex', transcript: { status: 'ok' }, tokens, cost,
    costByExecution: { topLevelUsd: 0, subagentUsd: 0, unknownUsd: 0 }, metrics: { modelCalls: 1 },
    models: [{ model, ...tokens, ...cost, calls: 1 }], spendByDay: {},
    velocity: { dimensions: [{ model, executionKind: 'top-level' }],
      buckets: [['2026-10-01', 8, 0, [0, input, input, 0, 0, output, reasoning, 1, 0, 0, 0, output, input, 0]]], undated: [] } };
}

test('independent Codex census owns broadcast counters once, retains a distinct request and uses the snapshot calendar', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-current-oracle-'));
  try {
    const source = join(root, 'home/.codex/sessions'), snapshotPath = join(root, 'snapshot.json');
    await mkdir(source, { recursive: true }); await mkdir(join(root, '.lane'));
    const a = 'a0000000-0000-4000-8000-000000000001', b = 'b0000000-0000-4000-8000-000000000002';
    const prefix = id => [record('23:00:00', 'session_meta', { id, cwd: root, source: 'cli' }), record('23:00:01', 'turn_context', { model }), count('23:20:00', usage(100, 10, 0))];
    const broadcast = count('23:30:00', usage(130, 16, 2));
    const rowsA = [...prefix(a), record('23:29:59.500', 'response_item', { type: 'message', role: 'assistant', content: 'PRIVATE_ORACLE_SENTINEL' }), broadcast, broadcast];
    const rowsB = [...prefix(b), record('23:29:59', 'response_item', { type: 'message', role: 'assistant' }), broadcast,
      record('23:39:59', 'response_item', { type: 'message', role: 'assistant' }), count('23:40:00', usage(150, 20, 3), usage(20, 4, 1))];
    for (const [id, rows] of [[a, rowsA], [b, rowsB]]) await writeFile(join(source, `${id}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const snapshot = { generatedAt: '2026-10-02T00:00:00Z', velocity: { timeZone: 'Asia/Tokyo' }, sessions: [session(a, 30, 6, 2), session(b, 20, 4, 1)] };
    await writeFile(snapshotPath, JSON.stringify(snapshot));
    const env = { ...process.env, HOME: join(root, 'home'), TZ: 'UTC', CODEX_ORACLE_ROOT: join(root, 'home/.codex'), CODEX_ORACLE_REFERENCE: snapshotPath };
    const run = async name => {
      const result = spawnSync(process.execPath, [fileURLToPath(new URL(name, import.meta.url))], { cwd: root, encoding: 'utf8', env });
      assert.equal(result.status, 0, result.stderr);
    };
    await run('oracle.mjs');
    await run('current-reconciliation.mjs');
    const text = await readFile(join(root, '.lane/codex-current.json'), 'utf8'), report = JSON.parse(text);
    assert.doesNotMatch(text, /PRIVATE_ORACLE_SENTINEL/);
    assert.deepEqual(report.differences, []);
    assert.deepEqual(report.missing, []);
    assert.equal(report.summary.retainedEvents, 2);
    assert.deepEqual(report.retained.map(event => event.basis).sort(), ['cumulative-interval', 'legacy']);
    // Deliberately corrupt the supplied answer: the independent arithmetic must reject it.
    snapshot.sessions[0].tokens.inputTokens++;
    await writeFile(snapshotPath, JSON.stringify(snapshot));
    await run('current-reconciliation.mjs');
    const rejected = JSON.parse(await readFile(join(root, '.lane/codex-current.json'), 'utf8'));
    assert.ok(rejected.differences.some(row => row.scope === 'session' && row.field === 'inputTokens' && row.delta === 1));
  } finally { await rm(root, { recursive: true, force: true }); }
});
