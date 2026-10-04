import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { analyzeRepositorySessions } from '../../src/analyzer.ts';
import { createSessionAnalyticsFixture } from '../fixtures.ts';

type StreamRecord = { timestamp: string | null; output: number };
async function analyzeStream(records: StreamRecord[]) {
  const root = await mkdtemp(join(tmpdir(), 'time-claude-stream-'));
  try {
    const fixture = await createSessionAnalyticsFixture(root);
    const [directory] = await readdir(fixture.claudeRoot);
    assert.ok(directory);
    const project = join(fixture.claudeRoot, directory);
    const file = (await readdir(project)).find(name => name.endsWith('.jsonl'));
    assert.ok(file);
    const original = (await readFile(join(project, file), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
    const identity = original.find(record => record['type'] === 'assistant');
    assert.ok(identity);
    await rm(join(project, file.slice(0, -6)), { recursive: true, force: true });
    await writeFile(join(project, file), records.map(({ timestamp, output }) => JSON.stringify({
      type: 'assistant', timestamp, sessionId: identity['sessionId'], cwd: identity['cwd'],
      message: { id: 'synthetic-stream', model: 'claude-opus-5', role: 'assistant', content: [{ type: 'text', text: 'SYNTHETIC_PRIVATE_SENTINEL' }],
        usage: { input_tokens: 100, output_tokens: output } },
    })).join('\n') + '\n');
    const snapshot = await analyzeRepositorySessions({ ...fixture, pricingPolicy: 'reviewed-only', repositoryRemote: fixture.remote });
    assert.ok(!JSON.stringify(snapshot).includes('SYNTHETIC_PRIVATE_SENTINEL'));
    const claude = snapshot.sessions.find(session => session.provider === 'claude');
    assert.ok(claude);
    return claude;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('Claude stream date is the earliest evidenced request instant even when replayed blocks arrive out of order', async () => {
  const session = await analyzeStream([
    { timestamp: '2026-10-01T00:00:02Z', output: 20 },
    { timestamp: '2026-09-30T23:59:58Z', output: 10 },
  ]);
  assert.equal(session.tokens.outputTokens, 20);
  assert.equal(session.firstEventAt, '2026-09-30T23:59:58.000Z');
  assert.deepEqual(session.spendByDay, { '2026-09-30': session.cost.totalUsd });
});

test('a dated duplicate repairs an undated Claude usage snapshot without requiring larger output', async () => {
  const session = await analyzeStream([
    { timestamp: null, output: 20 },
    { timestamp: '2026-09-30T23:59:58Z', output: 20 },
  ]);
  assert.equal(session.models[0]?.calls, 1);
  assert.deepEqual(session.spendByDay, { '2026-09-30': session.cost.totalUsd });
});

test('chronological Claude blocks crossing a month keep the complete final usage on the first request date', async () => {
  const session = await analyzeStream([
    { timestamp: '2026-09-30T23:59:58Z', output: 10 },
    { timestamp: '2026-10-01T00:00:02Z', output: 20 },
  ]);
  assert.equal(session.tokens.outputTokens, 20);
  assert.deepEqual(session.spendByDay, { '2026-09-30': session.cost.totalUsd });
});
