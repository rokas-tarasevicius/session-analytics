import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { cursorTranscriptAdapter } from '../../src/providers/cursor-transcript.ts';
import { zeroCost } from '../../src/providers/common.ts';

const parent = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const child = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('CURSOR-NATIVE-07: explicit transcript ancestry preserves subagent identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-hierarchy-validation-'));
  try {
    const directory = join(root, 'synthetic-project', 'agent-transcripts', parent, 'subagents');
    await mkdir(directory, { recursive: true });
    const content = [
      { role: 'user', message: { content: [{ type: 'text', text: 'PRIVATE_PROMPT_SENTINEL' }] } },
      { role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', id: 'private-tool-id', input: { path: 'PRIVATE_FILE_SENTINEL' } }] } },
    ].map(r => JSON.stringify(r)).join('\n');
    await writeFile(join(directory, `${child}.jsonl`), content);
    await writeFile(join(directory, '..', `${parent}.jsonl`), content);
    const adapter = cursorTranscriptAdapter();
    const identities = [];
    for await (const identity of adapter.identify(root)) identities.push(identity);
    assert.equal(identities.length, 2);
    const context = { repository: { id: 'synthetic-repository', name: 'Synthetic' }, rateCard: { currency: 'USD' as const, effectiveDate: '2026-01-01', models: {} }, price: () => zeroCost() };
    const ordinary = await adapter.analyze(identities.find(i => i.id === parent)!, context);
    assert.equal(ordinary!.executionKind, 'unknown', 'ordinary layout can be a legacy subagent fallback');
    const result = await adapter.analyze(identities.find(i => i.id === child)!, context);
    assert.ok(result);
    for (const secret of [root, parent, child, 'PRIVATE_PROMPT_SENTINEL', 'PRIVATE_FILE_SENTINEL', 'private-tool-id']) assert.ok(!JSON.stringify(result).includes(secret));
    assert.equal(result.metrics.userTurns, 1);
    assert.equal(result.metrics.assistantMessages, 1);
    assert.equal(result.metrics.toolCalls, 1);
    assert.equal(result.tokens.inputTokens + result.tokens.outputTokens, 0);
    assert.equal(result.executionKind, 'subagent');
  } finally { await rm(root, { recursive: true, force: true }); }
});
