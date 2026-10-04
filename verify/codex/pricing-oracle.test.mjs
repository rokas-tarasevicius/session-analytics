import assert from 'node:assert/strict';
import test from 'node:test';
import { priceUsage, lookupRate, normalizeUsage, auditSnapshot } from './pricing-oracle.mjs';

test('cached input and reasoning output remain subsets', () => {
  const usage = { input_tokens: 1_000_000, cached_input_tokens: 800_000, output_tokens: 100_000, reasoning_output_tokens: 90_000 };
  assert.deepEqual(normalizeUsage(usage), { input: 1_000_000, cached: 800_000, uncached: 200_000, output: 100_000, reasoning: 90_000, nonReasoning: 10_000, total: 1_100_000 });
  const price = priceUsage('gpt-6-astra', usage);
  assert.equal(price.inputUsd, 2);
  assert.equal(price.cachedInputUsd, .8);
  assert.equal(price.outputUsd, 5);
  assert.equal(price.totalUsd, 7.8);
  assert.equal(price.upperEstimateUsd, 8.3);
});

test('long-context threshold applies per request and is strict', () => {
  const usage = { input: 272000, cached: 0, output: 10000 };
  const at = priceUsage('gpt-5.6-sol', usage, { requestInputTokens: 272000 });
  const over = priceUsage('gpt-5.6-sol', usage, { requestInputTokens: 272001 });
  assert.equal(at.longContext, false);
  assert.equal(over.longContext, true);
  assert.equal(over.inputUsd, 2 * at.inputUsd);
  assert.ok(Math.abs(over.outputUsd - 1.5 * at.outputUsd) < 1e-12);
  const unknown = priceUsage('gpt-5.6-sol', usage);
  assert.equal(unknown.totalUsd, at.totalUsd);
  assert.ok(Math.abs(unknown.maximumLongContextUsd - over.totalUsd) < 1e-12);
});

test('only unambiguous documented aliases match; unknown is not zero rated', () => {
  assert.equal(lookupRate('openai/gpt-5-4-2026-03-05').model, 'gpt-5.4');
  assert.equal(lookupRate('gpt-5.4-mini').model, 'gpt-5.4-mini');
  assert.equal(lookupRate('reseller/gpt-5.4'), null);
  assert.equal(priceUsage('unknown-model', { input: 1000 }).priced, false);
  assert.equal(priceUsage('gpt-5.3-codex-spark', { input: 1000 }).priced, false);
  assert.equal(priceUsage('gpt-5.3-codex-spark', { input: 1000 }).totalUsd, 0);
});

test('empty snapshot has zero aggregates and no invented coverage failures', () => {
  const result = auditSnapshot({ generatedAt: '2026-01-01T00:00:00.000Z', sessions: [] });
  assert.equal(result.total.sessions, 0);
  assert.equal(result.total.referenceUsd, 0);
  assert.deepEqual(result.invariantFailures, []);
});

test('official historical reductions apply at request timestamps', () => {
  const usage = { input: 1000, output: 100 };
  assert.equal(priceUsage('gpt-5.6-sol', usage, { timestamp: '2026-08-20T23:59:59Z' }).totalUsd, .008);
  assert.equal(priceUsage('gpt-5.6-sol', usage, { timestamp: '2026-08-21T00:00:00Z' }).totalUsd, .006);
});
