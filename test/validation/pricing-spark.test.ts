import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogFromSnapshots, loadReviewed, pricingCoverage, resolveRate } from '../../src/pricing/catalog.ts';
import { normalizeSource, sha256, SOURCE_URLS } from '../../src/pricing/sources.ts';

// A subscription research preview with no published API tariff is unavailable pricing,
// not an explicitly published free API. A zero supplied by a feed must not change that.
for (const pricingPolicy of ['reviewed-first', 'api-first', 'reviewed-only'] as const) {
  test(`PRICING-SPARK: ${pricingPolicy} leaves subscription-only preview API value unpriced`, async () => {
    const payload = { openai: { models: {
      'gpt-5.3-codex-spark': { cost: { input: 0, output: 0, cache_read: 0 } },
      'gpt-fixture-free': { cost: { input: 0, output: 0, cache_read: 0 } },
    } } };
    const source = { version: 1 as const, source: 'models.dev' as const, sourceUrl: SOURCE_URLS['models.dev'],
      fetchedAt: '2026-10-03T00:00:00.000Z', payloadSha256: sha256(JSON.stringify(payload)), ...normalizeSource('models.dev',payload) };
    const catalog = catalogFromSnapshots(await loadReviewed(), [source], { pricingPolicy }, new Date('2026-10-04T00:00:00.000Z'));
    assert.equal(resolveRate(catalog, 'gpt-5.3-codex-spark', '2026-06-01T00:00:00.000Z'), undefined);
    assert.equal(resolveRate(catalog, 'openai/gpt-5.3-codex-spark'), undefined);
    const coverage = pricingCoverage(catalog, ['gpt-5.3-codex-spark']);
    assert.equal(coverage.modelsPriced, 0);
    assert.equal(coverage.ratio, 0);
    if (pricingPolicy !== 'reviewed-only') assert.equal(resolveRate(catalog, 'gpt-fixture-free')?.rate.inputPerMillion, 0);
  });
}
