import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { analyzeMachineSessions } from '../../src/analyzer.ts';
import { createSessionAnalyticsFixture } from '../fixtures.ts';

const id = '67676767-6767-4676-8676-676767676767';
const sessionKey = createHash('sha256').update(`codex:${id}`).digest('hex').slice(0, 12);
const usage = (input: number, cached: number, output: number) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0 });
const token = (timestamp: string, total: ReturnType<typeof usage>, last: ReturnType<typeof usage>) => ({ type: 'event_msg', timestamp, payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } } });
const native = (timestamp: string, value: ReturnType<typeof usage>, total: ReturnType<typeof usage>) => ({ type: 'token_usage_record', timestamp, payload: { thread_id: id, response_id: 'synthetic-response-native', usage: value, thread_token_usage: total } });
async function analyze(records: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), 'time-native-safety-'));
  try {
    const fixture = await createSessionAnalyticsFixture(root);
    const rows = [
      { type: 'session_meta', timestamp: '2026-08-31T22:00:00Z', payload: { id, cwd: fixture.repositoryRoot, source: 'exec' } },
      { type: 'turn_context', timestamp: '2026-08-31T22:00:01Z', payload: { model: 'gpt-5.6-sol' } }, ...records,
    ];
    await writeFile(join(fixture.codexRoot, `rollout-${id}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const result = await analyzeMachineSessions({ ...fixture, pricingPolicy: 'reviewed-only' });
    assert.ok(!JSON.stringify(result).includes('synthetic-response-native'));
    const session = result.sessions.find(row => row.sessionKey === sessionKey);
    assert.ok(session);
    return session;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('native compaction usage must not reset the independent legacy cumulative baseline', async () => {
  const baseline = usage(100_000, 20_000, 1_000);
  const session = await analyze([
    token('2026-08-31T23:59:00Z', baseline, usage(10_000, 2_000, 100)),
    native('2026-09-01T00:00:01Z', usage(20_000, 3_000, 200), usage(120_000, 23_000, 1_200)),
    { type: 'compacted', timestamp: '2026-09-01T00:00:02Z', payload: { compaction_response_id: 'synthetic-response-native', message: 'synthetic summary' } },
    token('2026-09-01T00:00:03Z', baseline, usage(0, 0, 0)),
  ]);
  assert.equal(session.tokens.inputTokens, 30_000, 'unchanged legacy counters contribute no synthetic delta after a native record');
  assert.equal(session.tokens.outputTokens, 300);
  assert.equal(session.metrics.modelCalls, 2);
});

test('native recording with a restarted cumulative baseline preserves later unpaired legacy requests', async () => {
  const session = await analyze([
    token('2026-08-31T23:59:00Z', usage(100_000, 20_000, 1_000), usage(20_000, 4_000, 200)),
    native('2026-09-01T00:00:01Z', usage(10_000, 2_000, 100), usage(10_000, 2_000, 100)),
    token('2026-09-01T00:00:02Z', usage(110_000, 22_000, 1_100), usage(10_000, 2_000, 100)),
    token('2026-09-01T00:01:00Z', usage(115_000, 23_000, 1_150), usage(5_000, 1_000, 50)),
  ]);
  assert.equal(session.tokens.inputTokens, 35_000, 'paired native/legacy usage counts once and a later legacy-only request survives');
  assert.equal(session.tokens.outputTokens, 350);
  assert.equal(session.metrics.modelCalls, 3);
});
