import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { analyzeRepositorySessions } from '../../src/analyzer.ts';
import { createSessionAnalyticsFixture } from '../fixtures.ts';

for (const separator of ['\u2028', '\u2029']) {
  test(`Claude final stream usage survives legal JSON string U+${separator.codePointAt(0)!.toString(16).toUpperCase()}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'time-claude-unicode-'));
    try {
      const fixture = await createSessionAnalyticsFixture(root);
      const [directory] = await readdir(fixture.claudeRoot);
      assert.ok(directory);
      const project = join(fixture.claudeRoot, directory);
      const file = (await readdir(project)).find(name => name.endsWith('.jsonl'));
      assert.ok(file);
      const identity = (await readFile(join(project, file), 'utf8')).trim().split('\n')
        .map(line => JSON.parse(line) as Record<string, unknown>).find(record => record['type'] === 'assistant');
      assert.ok(identity);
      await rm(join(project, file.slice(0, -6)), { recursive: true, force: true });
      const blocks = [
        { timestamp: '2026-09-30T23:59:58Z', output: 10, content: 'SYNTHETIC_PRIVATE_SENTINEL' },
        { timestamp: '2026-10-01T00:00:02Z', output: 20, content: `SYNTHETIC_PRIVATE_SENTINEL${separator}still one JSONL record` },
      ];
      await writeFile(join(project, file), blocks.map(block => JSON.stringify({
        type: 'assistant', timestamp: block.timestamp, sessionId: identity['sessionId'], cwd: identity['cwd'],
        message: { id: 'synthetic-stream', model: 'claude-opus-5', role: 'assistant', content: [{ type: 'text', text: block.content }],
          usage: { input_tokens: 100, output_tokens: block.output } },
      })).join('\n') + '\n');
      const snapshot = await analyzeRepositorySessions({ ...fixture, pricingPolicy: 'reviewed-only', repositoryRemote: fixture.remote });
      assert.ok(!JSON.stringify(snapshot).includes('SYNTHETIC_PRIVATE_SENTINEL'));
      const session = snapshot.sessions.find(session => session.provider === 'claude');
      assert.ok(session);
      assert.equal(session.tokens.outputTokens, 20, 'final streamed output must survive content framing');
      assert.equal(session.cost.totalUsd, 0.001);
      assert.deepEqual(session.spendByDay, { '2026-09-30': 0.001 });
      assert.equal(session.lastEventAt, '2026-10-01T00:00:02.000Z');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
