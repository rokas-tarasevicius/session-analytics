import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { analyzeMachineSessions } from '../../src/analyzer.ts';

async function run(file: string, cwd: string, reference: string): Promise<void> {
  const child = spawn(process.execPath, [new URL(`../../verify/codex/${file}`, import.meta.url).pathname], {
    cwd, env: { ...process.env, CODEX_ORACLE_ROOT: join(cwd, 'codex'), CODEX_ORACLE_REFERENCE: reference }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = ''; child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; }); child.stdout.resume();
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, errors);
}

test('independent current Codex oracle reconciles receipt aliases, compaction, continuations, forks and local hours', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-current-oracle-'));
  try {
    const codexRoot = join(root, 'codex', 'sessions'), codexArchiveRoot = join(root, 'codex', 'archived_sessions'), claudeRoot = join(root, 'claude');
    await Promise.all([codexRoot, codexArchiveRoot, claudeRoot, join(root, '.lane')].map(path => mkdir(path, { recursive: true })));
    const parent = 'dddddddd-0000-4000-8000-000000000000', child = 'eeeeeeee-0000-4000-8000-000000000000', taskOnly = 'ffffffff-0000-4000-8000-000000000000';
    const u = (input: number, output: number) => ({ input_tokens: input, cached_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0 });
    const record = (type: string, at: string, payload: unknown) => ({ type, timestamp: at, payload });
    const header = (id: string, at: string, forked_from_id?: string) => record('session_meta', at, { id, cwd: root, source: 'cli', forked_from_id });
    const turn = (at: string) => record('turn_context', at, { model: 'gpt-5.6-sol', turn_id: 'turn' });
    const count = (at: string, total: number, output: number, last: number, lastOutput: number) => record('event_msg', at, { type: 'token_count', info: { total_token_usage: u(total, output), last_token_usage: u(last, lastOutput) } });
    const receipt = (at: string, response_id: string, input: number, output: number, total: number, totalOutput: number) => record('token_usage_record', at, { thread_id: parent, response_id, turn_id: 'turn', usage: u(input, output), thread_token_usage: u(total, totalOutput) });
    const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
    await writeFile(join(codexRoot, `rollout-${parent}.jsonl`), jsonl([
      header(parent, '2026-08-20T22:00:00Z'), turn('2026-08-20T22:00:01Z'),
      receipt('2026-08-20T22:01:00Z', 'first', 100, 10, 100, 10), count('2026-08-20T22:01:01Z', 100, 10, 100, 10),
      receipt('2026-08-21T00:01:00Z', 'compact', 25, 5, 125, 15), record('compacted', '2026-08-21T00:01:01Z', { compaction_response_id: 'compact' }), count('2026-08-21T00:01:02Z', 125, 15, 0, 0),
    ]));
    await writeFile(join(codexArchiveRoot, `rollout-${parent}.jsonl`), jsonl([header(parent, '2026-08-21T01:00:00Z'), turn('2026-08-21T01:00:01Z'), receipt('2026-08-21T01:01:00Z', 'first', 100, 10, 100, 10)]));
    await writeFile(join(codexRoot, `rollout-${child}.jsonl`), jsonl([
      header(child, '2026-08-21T02:00:00Z', parent), turn('2026-08-21T02:00:01Z'), count('2026-08-20T22:01:01Z', 100, 10, 100, 10),
      count('2026-08-21T02:01:00Z', 225, 25, 100, 10), count('2026-08-21T03:01:00Z', 325, 35, 0, 0),
    ]));
    await writeFile(join(codexRoot, `rollout-${taskOnly}.jsonl`), jsonl([header(taskOnly, '2026-08-21T04:00:00Z'), record('event_msg', '2026-08-21T04:01:00Z', { type: 'task_complete' })]));
    const snapshot = await analyzeMachineSessions({ codexRoot, codexArchiveRoot, claudeRoot, noIndex: true, offline: true, additionalProviders: false,
      dataDir: join(root, 'data'), databasePath: join(root, 'none.db'), cursorDatabasePath: join(root, 'none-cursor.db') });
    const reference = join(root, 'snapshot.json'); await writeFile(reference, JSON.stringify(snapshot));
    await run('oracle.mjs', root, reference); await run('current-reconciliation.mjs', root, reference);
    const report = JSON.parse(await readFile(join(root, '.lane', 'codex-current.json'), 'utf8'));
    assert.equal(report.summary.matched, 3);
    assert.equal(report.summary.eligibleIdentities, 3);
    assert.equal(report.summary.unclassifiedDiscovery, 0);
    assert.equal(report.summary.retainedEvents, 4);
    assert.deepEqual(report.differences, []);
    assert.deepEqual(report.missing, []);
    assert.equal(report.retained.reduce((sum: number, event: { u: number[] }) => sum + event.u[0]!, 0), 325);
    assert.equal(report.retained.reduce((sum: number, event: { u: number[] }) => sum + event.u[6]!, 0), 35);
    // August 20 Sol is $5/$0.50/$30; August 21 is $4/$0.40/$20.
    assert.ok(Math.abs(report.retained.reduce((sum: number, event: { usd: number }) => sum + event.usd, 0) - 0.0022) < 1e-12);
    assert.ok(Math.abs(report.retained.reduce((sum: number, event: { cost: { upperEstimateUsd: number } }) => sum + event.cost.upperEstimateUsd, 0) - 0.00255) < 1e-12);
    // A one-token error and missing numeric operand must both fail comparison.
    const target = snapshot.sessions.find(session => session.metrics.modelCalls > 0)!;
    target.tokens.inputTokens += 1;
    target.models[0]!.calls = Number.NaN;
    snapshot.sessions = snapshot.sessions.filter(session => session.metrics.modelCalls > 0);
    await writeFile(reference, JSON.stringify(snapshot));
    await run('current-reconciliation.mjs', root, reference);
    const invalid = JSON.parse(await readFile(join(root, '.lane', 'codex-current.json'), 'utf8'));
    assert.ok(invalid.differences.some((row: { scope: string; field: string; delta: number }) => row.scope === 'session' && row.field === 'inputTokens' && row.delta === 1));
    assert.ok(invalid.differences.some((row: { field: string }) => row.field === 'calls'));
    assert.equal(invalid.missing.length, 1);
    assert.equal(invalid.missing[0].calls, 0);
    assert.equal(invalid.missing[0].tokens, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
