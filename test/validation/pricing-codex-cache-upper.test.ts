import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { normalizeSource } from '../../src/pricing/sources.ts';
import { priceUsage } from '../../src/pricing/usage.ts';
import type { ModelRate, TokenUsage } from '../../src/types.ts';

// Synthetic token counts; official tariff evidence is in verify/pricing/official-rates.json.
const usage: TokenUsage = {
  inputTokens: 1_000_000, uncachedInputTokens: 1_000_000, cachedInputTokens: 0,
  outputTokens: 1_000_000, reasoningOutputTokens: 300_000, nonReasoningOutputTokens: 700_000,
  cacheWriteInputTokens: 0, cacheWrite5mInputTokens: 0, cacheWrite1hInputTokens: 0,
};
const models = ['gpt-5.3-codex', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.5'];
for (const source of ['models.dev', 'litellm'] as const) {
  for (const model of models) test(`VP-CODEX-UPPER ${source}: ${model} has no cache-write surcharge`, () => {
    const payload = source === 'models.dev'
      ? { openai: { models: { [model]: { cost: { input: 2, output: 10, cache_read: 0.2 } } } } }
      : { [model]: { litellm_provider: 'openai', input_cost_per_token: 0.000002,
          output_cost_per_token: 0.00001, cache_read_input_token_cost: 0.0000002 } };
    const rate = normalizeSource(source, payload).models[model]!;
    const priced = priceUsage(rate, usage, 1_000);
    assert.equal(priced.cost.upperEstimateUsd, priced.cost.totalUsd);
    assert.ok(!priced.assumptions.includes('codex-cache-write-upper-1.25x'));
  });
}
for (const model of models) test(`VP-CODEX-UPPER bundled rate: ${model} has no cache-write surcharge`, () => {
  const card = JSON.parse(readFileSync(new URL('../../data/rate-cards.json', import.meta.url), 'utf8')) as { models: Record<string, ModelRate> };
  const priced = priceUsage(card.models[model]!, usage, 1_000);
  assert.equal(priced.cost.upperEstimateUsd, priced.cost.totalUsd);
});

test('VP-CODEX-UPPER an explicit custom-card multiplier remains authoritative', () => {
  const rate: ModelRate = { provider: 'codex', inputPerMillion: 2, outputPerMillion: 10,
    cachedInputPerMillion: 0.2, cacheWriteObservable: false, cacheWriteMultiplier: 1.5,
    source: 'https://example.com/synthetic-rate-card' };
  const priced = priceUsage(rate, usage, 1_000);
  assert.equal(priced.cost.totalUsd, 12);
  assert.equal(priced.cost.upperEstimateUsd, 13);
});

test('VP-CODEX-UPPER feed evidence for a paid cache-write rate controls its upper bound', () => {
  const rate = normalizeSource('models.dev', { openai: { models: {
    'gpt-fixture': { cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 3 } },
  } } }).models['gpt-fixture']!;
  assert.equal(priceUsage(rate, usage, 1_000).cost.upperEstimateUsd, 13);
});

test('VP-CODEX-UPPER persisted legacy API normalization is corrected for historical requests', async () => {
  const { catalogFromSnapshots, loadReviewed, resolveRate } = await import('../../src/pricing/catalog.ts');
  const { SOURCE_URLS } = await import('../../src/pricing/sources.ts');
  const reviewed = await loadReviewed();
  const oldRate: ModelRate = { provider: 'codex', inputPerMillion: 0.75, cachedInputPerMillion: 0.075,
    outputPerMillion: 4.5, cacheWriteObservable: false, cacheWriteMultiplier: 1.25,
    assumptions: ['codex-cache-write-upper-1.25x'], source: SOURCE_URLS['models.dev'] };
  const payloadSha256 = 'a'.repeat(64);
  const catalog = catalogFromSnapshots(reviewed, [{ version: 1, source: 'models.dev',
    sourceUrl: SOURCE_URLS['models.dev'], fetchedAt: '2026-10-03T00:00:00.000Z', payloadSha256,
    models: { 'gpt-5.4-mini': oldRate }, rejectedModels: 0 }], { pricingPolicy: 'api-first' }, new Date('2026-10-04'));
  const selected = resolveRate(catalog, 'gpt-5.4-mini', '2026-07-01T00:00:00Z')!;
  const priced = priceUsage(selected.rate, usage, 1_000);
  assert.equal(priced.cost.upperEstimateUsd, priced.cost.totalUsd);
  assert.ok(!selected.provenance.assumptions.includes('codex-cache-write-upper-1.25x'));
  assert.equal(selected.provenance.payloadSha256, payloadSha256);
  assert.equal(selected.provenance.snapshotDate, '2026-10-03T00:00:00.000Z');
  assert.equal(oldRate.cacheWriteMultiplier, 1.25, 'stored source observation remains immutable');
});
