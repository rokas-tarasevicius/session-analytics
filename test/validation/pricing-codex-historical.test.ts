import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadPricingCatalog, resolveRate } from '../../src/pricing/catalog.ts';

test('VP-CODEX-HISTORY Sol requests before the August reduction retain the prior tariff', async () => {
  const catalog = await loadPricingCatalog({ offline: true, dataDir: join(tmpdir(), 'validation-no-pricing-cache') });
  const historical = resolveRate(catalog, 'gpt-5.6-sol', '2026-08-20T12:00:00Z')!;
  assert.equal(historical.rate.inputPerMillion, 5);
  assert.equal(historical.rate.cachedInputPerMillion, 0.5);
  assert.equal(historical.rate.outputPerMillion, 30);
  assert.equal(historical.provenance.source, 'reviewed');
  assert.equal(historical.rate.source, 'https://developers.openai.com/api/docs/changelog');
  assert.equal(historical.provenance.snapshotDate, '2026-07-09T00:00:00.000Z');
  assert.equal(historical.provenance.temporal, 'at-or-before');
});

test('VP-CODEX-HISTORY Terra requests before the July reduction retain the inferred prior tariff', async () => {
  const catalog = await loadPricingCatalog({ offline: true, dataDir: join(tmpdir(), 'validation-no-pricing-cache') });
  const historical = resolveRate(catalog, 'openai/gpt-5.6-terra', '2026-07-29T12:00:00Z')!;
  assert.equal(historical.rate.inputPerMillion, 2.5);
  assert.equal(historical.rate.cachedInputPerMillion, 0.25);
  assert.equal(historical.rate.outputPerMillion, 15);
});

test('VP-CODEX-HISTORY published change days and undated requests use current rates', async () => {
  const catalog = await loadPricingCatalog({ offline: true, dataDir: join(tmpdir(), 'validation-no-pricing-cache') });
  assert.equal(resolveRate(catalog, 'gpt-5.6-sol', '2026-08-21T00:00:00Z')!.rate.inputPerMillion, 4);
  assert.equal(resolveRate(catalog, 'gpt-5.6-terra', '2026-07-30T00:00:00Z')!.rate.inputPerMillion, 2);
  assert.equal(resolveRate(catalog, 'gpt-5.6-sol')!.rate.inputPerMillion, 4);
});

test('VP-CODEX-HISTORY an explicit custom card remains authoritative for old dates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pricing-history-validation-'));
  try {
    const rateCardPath = join(directory, 'rates.json');
    await writeFile(rateCardPath, JSON.stringify({ currency: 'USD', effectiveDate: '2026-10-02',
      models: { 'gpt-5.6-sol': { provider: 'codex', inputPerMillion: 77,
        cachedInputPerMillion: 7, outputPerMillion: 99, source: 'https://example.com/synthetic' } } }));
    const catalog = await loadPricingCatalog({ rateCardPath, offline: true, dataDir: directory });
    assert.equal(resolveRate(catalog, 'gpt-5.6-sol', '2026-08-20T12:00:00Z')!.rate.inputPerMillion, 77);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
