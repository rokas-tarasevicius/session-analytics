import assert from 'node:assert/strict';
import test from 'node:test';
import { createPricer, matchRate } from './pricing.mjs';

const model = 'claude-fixture-1-2';
const rate = { provider: 'claude', inputPerMillion: 3, cacheReadPerMillion: 0.3, cacheWrite5mPerMillion: 3.75, cacheWrite1hPerMillion: 6, outputPerMillion: 15 };
const bundled = { effectiveDate: '2026-01-01', reviewedOverrides: [], models: { [model]: rate } };
const snapshot = (source, fetchedAt, values) => ({ source, fetchedAt, models: { [model]: { ...rate, ...values } } });

test('independent oracle hand-priced token classes and reasoning subset', () => {
  const price = createPricer({ bundled, snapshots: [], sources: [], reviewed: [] });
  const result = price(model, { input: 1000, cacheRead: 2000, cacheWrite5m: 3000, cacheWrite1h: 4000, cacheWriteUnknown: 5000, output: 6000, reasoning: 1000 }, '2026-02-01');
  assert.equal(result.inputUSD, 0.003);
  assert.equal(result.cacheReadUSD, 0.0006);
  assert.equal(result.cacheWriteUSD, 0.054);
  assert.equal(result.outputUSD, 0.09);
  assert.ok(Math.abs(result.costUSD - 0.1476) < 1e-12);
});

test('independent oracle selects absolute context tiers above, not at, threshold', () => {
  const price = createPricer({ bundled, sources: ['models.dev'], snapshots: [snapshot('models.dev', '2026-02-01', {
    contextTiers: [{ aboveInputTokens: 200000, inputPerMillion: 6, cacheReadPerMillion: 0.6, cacheWrite5mPerMillion: 7.5, cacheWrite1hPerMillion: 12, outputPerMillion: 22.5 }],
  })] });
  assert.equal(price(model, { input: 199900, cacheRead: 100, output: 100 }, '2026-03-01').inputUSD, 199900 * 3 / 1e6);
  const result = price(model, { input: 199900, cacheRead: 100, cacheWrite1h: 1, output: 100 }, '2026-03-01');
  assert.equal(result.inputUSD, 199900 * 6 / 1e6);
  assert.equal(result.cacheReadUSD, 0.00006);
  assert.equal(result.cacheWriteUSD, 0.000012);
  assert.equal(result.outputUSD, 0.00225);
});

test('independent oracle prefers timely lower-priority source over later higher-priority source', () => {
  const price = createPricer({ bundled, sources: ['models.dev', 'litellm'], snapshots: [
    snapshot('models.dev', '2026-03-01', { inputPerMillion: 9 }),
    snapshot('litellm', '2026-02-01', { inputPerMillion: 4 }),
  ] });
  assert.equal(price(model, { input: 1e6 }, '2026-02-15').costUSD, 4);
  assert.equal(price(model, { input: 1e6 }, '2026-01-15').costUSD, 9);
  assert.equal(price(model, { input: 1e6 }, '2026-03-15').costUSD, 9);
});

test('independent oracle reviewed override pins the complete model', () => {
  const price = createPricer({ bundled: { ...bundled, reviewedOverrides: [model] }, sources: ['models.dev'], snapshots: [snapshot('models.dev', '2026-02-01', { inputPerMillion: 9, cacheReadPerMillion: 4 })] });
  assert.equal(price(model, { input: 1e6, cacheRead: 1e6 }, '2026-03-01').costUSD, 3.3);
});

test('independent oracle refuses ambiguous dated aliases and preserves exact variants', () => {
  const models = { [`${model}-20260101`]: rate, [`${model}-20260201`]: rate };
  assert.equal(matchRate(model, models), null);
  assert.equal(matchRate('anthropic/claude-fixture-1.2-20260101', models)?.model, `${model}-20260101`);
  assert.equal(matchRate('claude-fixture-1-2-mini', models), null);
});
