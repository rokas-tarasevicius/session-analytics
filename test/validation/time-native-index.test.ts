import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { analyzeMachineSessions } from '../../src/analyzer.ts';
import { IndexScan } from '../../src/store/index.ts';
import { indexStatus, pruneIndex } from '../../src/store/database.ts';
import { createSessionAnalyticsFixture } from '../fixtures.ts';

const jsonl = (records: unknown[]) => records.map(row => JSON.stringify(row)).join('\n') + '\n';
const key = (id: string) => createHash('sha256').update(`codex:${id}`).digest('hex').slice(0, 12);

test('time-native-index: adding a paired legacy state invalidates an unchanged native-only session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'time-native-index-'));
  try {
    const fixture = await createSessionAnalyticsFixture(root);
    const options = { ...fixture, noIndex: false, pricingPolicy: 'reviewed-only' as const };
    const a = '77777777-aaaa-4777-8777-aaaaaaaaaaaa', b = '88888888-bbbb-4888-8888-bbbbbbbbbbbb';
    const identity = (id: string) => ({ type: 'session_meta', timestamp: '2026-09-01T00:00:00Z', payload: { id, cwd: fixture.repositoryRoot, source: 'exec' } });
    const context = { type: 'turn_context', timestamp: '2026-09-01T00:00:01Z', payload: { model: 'gpt-5.6-sol' } };
    const complete = { type: 'event_msg', timestamp: '2026-09-01T00:10:01Z', payload: { type: 'task_complete' } };
    const usage = { input_tokens: 10_000, cached_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 0 };
    await writeFile(join(fixture.codexRoot, `rollout-${a}.jsonl`), jsonl([identity(a), context,
      { type: 'token_usage_record', timestamp: '2026-09-01T00:10:00Z', payload: { thread_id: a, response_id: 'synthetic-native-response', usage, thread_token_usage: usage } }, complete,
    ]));
    const initial = await analyzeMachineSessions(options);
    assert.equal(initial.sessions.find(session => session.sessionKey === key(a))!.tokens.inputTokens, 10_000, 'A provider-issued response identity directly evidences a billable request');
    await writeFile(join(fixture.codexRoot, `rollout-${b}.jsonl`), jsonl([identity(b), context,
      { type: 'event_msg', timestamp: '2026-09-01T00:10:00Z', payload: { type: 'token_count', info: { total_token_usage: usage, last_token_usage: usage } } }, complete,
    ]));
    const cached = await analyzeMachineSessions(options);
    const full = await analyzeMachineSessions({ ...options, noIndex: true });
    const select = (snapshot: typeof full) => snapshot.sessions.filter(session => [key(a), key(b)].includes(session.sessionKey)).map(session => ({ key: session.sessionKey, input: session.tokens.inputTokens, output: session.tokens.outputTokens, days: session.spendByDay })).sort((x, y) => x.key.localeCompare(y.key));
    assert.equal(full.sessions.find(session => session.sessionKey === key(a))!.tokens.inputTokens, 10_000, 'Prerequisite: matching numeric state activates native recovery');
    assert.deepEqual(select(cached), select(full), 'Native eligibility depends on numeric ownership outside its physical source');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('time-native-index: changing a native-only producer defers its legacy counter consumers together', async () => {
  const root = await mkdtemp(join(tmpdir(), 'time-native-index-'));
  try {
    const fixture = await createSessionAnalyticsFixture(root);
    const options = { ...fixture, noIndex: false, pricingPolicy: 'reviewed-only' as const };
    const a = '77777777-aaaa-4777-8777-aaaaaaaaaaaa', b = '88888888-bbbb-4888-8888-bbbbbbbbbbbb';
    const paths = [a, b].map(id => join(fixture.codexRoot, `rollout-${id}.jsonl`));
    const identity = (id: string) => ({ type: 'session_meta', timestamp: '2026-09-01T00:00:00Z', payload: { id, cwd: fixture.repositoryRoot, source: 'exec' } });
    const context = { type: 'turn_context', timestamp: '2026-09-01T00:00:01Z', payload: { model: 'gpt-5.6-sol' } };
    const complete = { type: 'event_msg', timestamp: '2026-09-01T00:10:01Z', payload: { type: 'task_complete' } };
    const usage = { input_tokens: 10_000, cached_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 0 };
    const token = { type: 'event_msg', timestamp: '2026-09-01T00:10:00Z', payload: { type: 'token_count', info: { total_token_usage: usage, last_token_usage: usage } } };
    await writeFile(paths[0]!, jsonl([identity(a), context, complete]));
    await writeFile(paths[1]!, jsonl([identity(b), context,
      { type: 'response_item', timestamp: '2026-09-01T00:09:59Z', payload: { type: 'message', role: 'assistant', content: [] } }, token, complete]));
    const select = (snapshot: Awaited<ReturnType<typeof analyzeMachineSessions>>) => snapshot.sessions.filter(session => [key(a), key(b)].includes(session.sessionKey));
    const initial = await analyzeMachineSessions(options);
    assert.equal(select(initial).reduce((sum, session) => sum + session.tokens.inputTokens, 0), 10_000);
    await appendFile(paths[0]!, jsonl([
      { type: 'token_usage_record', timestamp: '2026-09-01T00:10:00Z', payload: { thread_id: a, response_id: 'synthetic-native-response', usage, thread_token_usage: usage } },
      { type: 'compacted', timestamp: '2026-09-01T00:10:00.100Z', payload: { compaction_response_id: 'synthetic-native-response' } }, complete,
    ]));
    const commit = IndexScan.prototype.commit;
    IndexScan.prototype.commit = async function () {
      await appendFile(paths[0]!, '\n');
      return commit.call(this);
    };
    try {
      const changed = await analyzeMachineSessions(options);
      assert.equal(select(changed).find(session => session.sessionKey === key(a))!.tokens.inputTokens, 10_000, 'Prerequisite: native response recovery proposal is active');
    } finally { IndexScan.prototype.commit = commit; }
    const deferred = indexStatus(options).lastScan?.deferredSessions;
    await Promise.all(paths.map(path => rm(path)));
    const retained = await analyzeMachineSessions(options);
    assert.equal(select(retained).reduce((sum, session) => sum + session.tokens.inputTokens, 0), 10_000, 'A native producer and every numeric-state consumer must retain one accounting generation');
    assert.equal(deferred, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const pruned of [false, true]) test(`time-native-index: native aliases cannot rebill ${pruned ? 'pruned' : 'retained'} legacy ownership`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'time-native-retention-'));
  try {
    const fixture = await createSessionAnalyticsFixture(root);
    const options = { ...fixture, noIndex: false, pricingPolicy: 'reviewed-only' as const };
    const a = '77777777-aaaa-4777-8777-aaaaaaaaaaaa', b = '88888888-bbbb-4888-8888-bbbbbbbbbbbb';
    const identity = (id: string, timestamp: string) => ({ type: 'session_meta', timestamp, payload: { id, cwd: fixture.repositoryRoot, source: 'exec' } });
    const context = { type: 'turn_context', payload: { model: 'gpt-5.6-sol' } };
    const usage = { input_tokens: 10_000, cached_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 0 };
    const oldPath = join(fixture.codexRoot, `rollout-${a}.jsonl`);
    await writeFile(oldPath, jsonl([identity(a, '2026-09-01T00:00:00Z'), context,
      { type: 'event_msg', timestamp: '2026-09-01T00:10:00Z', payload: { type: 'token_count', info: { total_token_usage: usage, last_token_usage: usage } } },
      { type: 'event_msg', timestamp: '2026-09-01T00:10:01Z', payload: { type: 'task_complete' } },
    ]));
    await analyzeMachineSessions(options);
    await rm(oldPath);
    if (pruned) pruneIndex('2026-09-02', options);
    await writeFile(join(fixture.codexRoot, `rollout-${b}.jsonl`), jsonl([identity(b, '2026-09-03T00:00:00Z'), context,
      { type: 'token_usage_record', timestamp: '2026-09-03T00:10:00Z', payload: { thread_id: b, response_id: 'synthetic-native-response', usage, thread_token_usage: usage } },
      ...(pruned ? [{ type: 'compacted', timestamp: '2026-09-03T00:10:00.100Z', payload: { compaction_response_id: 'synthetic-native-response' } }] : []),
      { type: 'event_msg', timestamp: '2026-09-03T00:10:01Z', payload: { type: 'task_complete' } },
    ]));
    const result = await analyzeMachineSessions(options);
    assert.equal(result.sessions.find(session => session.sessionKey === key(b))!.tokens.inputTokens, 10_000, 'Distinct later response identity cannot be erased by numeric equality to an unrelated retained or pruned legacy request');
    assert.equal(result.sessions.filter(session => [key(a), key(b)].includes(session.sessionKey)).reduce((sum, session) => sum + session.tokens.inputTokens, 0), pruned ? 10_000 : 20_000);
  } finally { await rm(root, { recursive: true, force: true }); }
});
