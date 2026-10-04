import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('independent calibration pairs conserve query output and receipt floors at the saved snapshot cutoff', t => {
  const directory = mkdtempSync(join(tmpdir(), 'conductor-calibration-oracle-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pricing = join(directory, 'pricing'); mkdirSync(pricing); mkdirSync(join(directory, '.lane'));
  const model = 'claude-synthetic', secret = 'CALIBRATION-PRIVATE-SENTINEL';
  const at = '2030-01-01T12:00:00.000Z', later = '2030-01-01T14:00:00.000Z';
  writeFileSync(join(pricing, 'synthetic.json'), JSON.stringify({ snapshot: { source: 'reviewed', fetchedAt: '2029-01-01T00:00:00.000Z',
    card: { effectiveDate: '2029-01-01', models: { [model]: { inputPerMillion: 2, outputPerMillion: 10 } } } } }));
  const databasePath = join(directory, 'synthetic.db'), database = new DatabaseSync(databasePath);
  database.exec('CREATE TABLE sessions(id TEXT,claude_session_id TEXT,created_at TEXT,updated_at TEXT,agent_type TEXT); CREATE TABLE session_messages(id TEXT,session_id TEXT,content TEXT,full_message TEXT,created_at TEXT,sdk_message_id TEXT)');
  const sessions: object[] = [], expected: { sessionKey: string; valueUsd: number; receiptFloorApplied: boolean }[] = [];
  let sequence = 0;
  for (const kind of ['query', 'floor', 'result-only', 'assistant-only']) {
    const registration = `${secret}-${kind}`, providerId = `synthetic-${kind}`;
    const sessionKey = createHash('sha256').update(registration).digest('hex').slice(0, 12);
    database.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(registration, providerId, at, later, 'claude');
    const event = (data: object, rowTime = at) => {
      const id = `synthetic-${++sequence}`, content = JSON.stringify({ session_id: providerId, uuid: id, ...data });
      database.prepare('INSERT INTO session_messages VALUES(?,?,?,?,?,?)').run(id, registration, content, content, rowTime, id);
    };
    if (kind !== 'result-only') event({ type: 'assistant', message: { id: `response-${kind}`, model, usage: { input_tokens: 100, output_tokens: 3 }, content: [{ type: 'text', text: secret }] } });
    if (kind !== 'assistant-only') event({ type: 'result', result: secret, total_cost_usd: kind === 'query' ? 0 : 2, usage: { input_tokens: 100, output_tokens: 1000 } });
    // Neither newly appended rows nor future-dated envelopes may rewrite a saved cohort.
    event({ type: 'result', total_cost_usd: 100 }, later);
    event({ type: 'result', timestamp: later, total_cost_usd: 100 });
    sessions.push({ sessionKey, provider: 'claude', transcript: { files: 1 } });
    expected.push({ sessionKey, valueUsd: kind === 'query' ? .0102 : kind === 'assistant-only' ? .00023 : 2, receiptFloorApplied: kind === 'floor' });
  }
  database.close();
  const reference = join(directory, 'snapshot.json');
  writeFileSync(reference, JSON.stringify({ generatedAt: '2030-01-01T13:00:00.000Z', sessions, rateCard: { pricing: { policy: 'reviewed-only', sources: [] } } }));
  const child = spawnSync(process.execPath, ['--import', fileURLToPath(new URL('../../scripts/verify-reference.mjs', import.meta.url)),
    fileURLToPath(new URL('../../verify/conductor/current-oracle.mjs', import.meta.url)), '--calibration'], {
    cwd: directory, encoding: 'utf8', env: { ...process.env, CONDUCTOR_DATABASE: databasePath, SESSION_ANALYTICS_VERIFY_REFERENCE: reference, CLAUDE_ORACLE_PRICING_DIR: pricing },
  });
  assert.equal(child.status, 0, child.stderr);
  const output = readFileSync(join(directory, '.lane/calibration-pairs.json'), 'utf8');
  const report = JSON.parse(output);
  assert.equal(report.generatedAt, '2030-01-01T13:00:00.000Z');
  assert.equal(report.pairs.length, expected.length);
  for (const [i, pair] of expected.entries()) {
    assert.deepEqual(Object.keys(report.pairs[i]).sort(), Object.keys(pair).sort());
    assert.equal(report.pairs[i].sessionKey, pair.sessionKey);
    assert.equal(report.pairs[i].receiptFloorApplied, pair.receiptFloorApplied);
    assert.ok(Math.abs(report.pairs[i].valueUsd - pair.valueUsd) < 1e-14);
  }
  for (const forbidden of [directory, secret, 'response-', 'synthetic-query']) assert.equal(output.includes(forbidden), false);
});
