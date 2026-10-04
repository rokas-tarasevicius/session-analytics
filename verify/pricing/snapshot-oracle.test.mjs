import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = fileURLToPath(new URL('./snapshot-oracle.mjs', import.meta.url));
const tokens = { inputTokens: 200, uncachedInputTokens: 200, cachedInputTokens: 0,
  cacheWriteInputTokens: 0, cacheWrite5mInputTokens: 0, cacheWrite1hInputTokens: 0,
  outputTokens: 20, reasoningOutputTokens: 0, nonReasoningOutputTokens: 20 };
function session(key, model, usage, costs, pricedTokens, extra = {}) {
  const eligibleTokens = usage.inputTokens + usage.outputTokens;
  return { sessionKey: key, repositoryId: 'synthetic', provider: 'codex',
    firstEventAt: '2026-08-20T12:00:00Z', lastEventAt: '2026-08-22T12:00:00Z',
    costBasis: 'api-list-price-equivalent', tokens: usage, cost: costs,
    pricedTokenCoverage: pricedTokens / eligibleTokens, metrics: { maxInputTokensPerCall: 100 },
    spendByDay: {}, models: [{ model, ...usage, ...costs, calls: 2,
      pricingCoverage: { eligibleTokens, pricedTokens } }], ...extra };
}
function run(sessions) {
  const root = mkdtempSync(path.join(tmpdir(), 'pricing-oracle-test-'));
  try {
    for (const dir of ['data', 'verify/pricing', 'cache']) mkdirSync(path.join(root, dir), { recursive: true });
    const json = (name, value) => writeFileSync(path.join(root, name), JSON.stringify(value));
    json('data/rate-cards.json', { effectiveDate: '2026-10-02', reviewedOverrides: ['gpt-5.6-sol', 'synthetic-ttl'], models: {
      'gpt-5.6-sol': { inputPerMillion: 4, cachedInputPerMillion: 0.4, outputPerMillion: 20,
        cacheWriteObservable: false, cacheWriteMultiplier: 1.25,
        longContext: { thresholdInputTokens: 272000, inputMultiplier: 2, outputMultiplier: 1.5 } },
      'synthetic-ttl': { inputPerMillion: 2, cachedInputPerMillion: 0.2, outputPerMillion: 10,
        cacheWrite5mPerMillion: 2.5, cacheWrite1hPerMillion: 4 },
    } });
    json('verify/pricing/official-rates.json', { history: [{ model: 'gpt-5.6-sol', from: '2026-07-09',
      untilExclusive: '2026-08-21', input: 5, cacheRead: 0.5, output: 30 }] });
    const sum = get => sessions.reduce((n, s) => n + get(s), 0);
    json('snapshot.json', { generatedAt: '2026-10-03T00:00:00Z', sessions, repositories: [], spendByModel: [], spendByDay: [],
      summary: { estimatedSpendUsd: sum(s => s.cost.totalUsd), apiEquivalentSpendUsd: sum(s => s.cost.totalUsd),
        providerReportedSpendUsd: 0, estimatedUpperSpendUsd: sum(s => s.cost.upperEstimateUsd),
        totalInputTokens: sum(s => s.tokens.inputTokens), outputTokens: sum(s => s.tokens.outputTokens),
        pricedTokenCoverage: sum(s => s.models[0].pricingCoverage.pricedTokens) / sum(s => s.tokens.inputTokens + s.tokens.outputTokens) } });
    const child = spawnSync(process.execPath, [script, 'snapshot.json', 'cache', 'result.json'], { cwd: root, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(readFileSync(path.join(root, 'result.json'), 'utf8'));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('aggregate across a tariff boundary requires exact raw request proof and still rejects invalid bounds', () => {
  // One request on each side: 100 input + 10 output; $5/$30 then $4/$20 per million.
  const row = session('synthetic-boundary', 'gpt-5.6-sol', tokens,
    { inputUsd: 0.0009, cachedInputUsd: 0, cacheWriteUsd: 0, outputUsd: 0.0005, totalUsd: 0.0014, upperEstimateUsd: 0.001625 }, 220);
  const result = run([row]);
  assert.deepEqual(result.mismatches, []);
  assert.deepEqual(result.rawRequestPricingRequired, [{ sessionKey: row.sessionKey, model: 'gpt-5.6-sol', multipleTariffs: true, premiumPossible: false }]);
  row.models[0].outputUsd = 10;
  assert.ok(run([row]).mismatches.some(m => m.scope === 'api-model-tariff-bounds' && m.field === 'outputUsd'));
});

test('recovered unsplit writes retain exact unknown-TTL upper and partial pricing coverage', () => {
  const row = session('synthetic-recovery', 'synthetic-ttl', { ...tokens, inputTokens: 100, uncachedInputTokens: 0,
    cacheWriteInputTokens: 100, outputTokens: 0, nonReasoningOutputTokens: 0 },
    { inputUsd: 0, cachedInputUsd: 0, cacheWriteUsd: 0.00025, outputUsd: 0, totalUsd: 0.00025, upperEstimateUsd: 0.0004 }, 0,
    { evidence: { kind: 'synthetic' }, provider: 'claude' });
  assert.deepEqual(run([row]).mismatches, []);
  row.models[0].upperEstimateUsd = row.cost.upperEstimateUsd = 0.00025;
  assert.ok(run([row]).mismatches.some(m => m.scope === 'api-model-formula' && m.field === 'upperEstimateUsd'));
});

test('context premium bounds cannot certify a raw request price', () => {
  const row = session('synthetic-context', 'gpt-5.6-sol', { ...tokens, inputTokens: 300000, uncachedInputTokens: 300000 },
    { inputUsd: 2.4, cachedInputUsd: 0, cacheWriteUsd: 0, outputUsd: 0.0006, totalUsd: 2.4006, upperEstimateUsd: 3.0006 }, 300020,
    { firstEventAt: '2026-09-01T00:00:00Z', lastEventAt: '2026-09-01T00:01:00Z', metrics: { maxInputTokensPerCall: 300000 } });
  const result = run([row]);
  assert.deepEqual(result.mismatches, []);
  assert.deepEqual(result.rawRequestPricingRequired, [{ sessionKey: row.sessionKey, model: 'gpt-5.6-sol', multipleTariffs: false, premiumPossible: true }]);
});
