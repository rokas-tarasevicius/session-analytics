import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { absentPriceEvidence } from '../../verify/other-providers/price-evidence.ts';

test('independent provider oracle uses copied price evidence and rejects corrupt blobs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oracle-price-evidence-'));
  const previous = process.env.SESSION_ANALYTICS_DATA_DIR;
  process.env.SESSION_ANALYTICS_DATA_DIR = directory;
  try {
    assert.deepEqual((await absentPriceEvidence(['grok-4.6', 'grok-4.7'])).missingModels, ['grok-4.6', 'grok-4.7']);
    const pricing = join(directory, 'pricing'); await mkdir(pricing);
    const sha = (value: string) => createHash('sha256').update(value).digest('hex');
    const payload = JSON.stringify({ 'xai/grok-4.6': { inputPerMillion: 2, outputPerMillion: 6 } });
    const snapshot = { source: 'models.dev', fetchedAt: '2026-10-03T00:00:00.000Z', payloadSha256: 'a'.repeat(64), modelsSha256: sha(payload) };
    const checksum = sha(JSON.stringify(snapshot));
    await writeFile(join(pricing, `rates-${snapshot.modelsSha256}.json`), payload);
    await writeFile(join(pricing, `models.dev-2026-10-03T000000000-${checksum}.json`), JSON.stringify({ storageVersion: 2, snapshot, checksum }));
    const evidence = await absentPriceEvidence(['grok-4.6', 'grok-4.7']);
    assert.deepEqual(evidence.missingModels, ['grok-4.7']);
    assert.equal(evidence.observations[0]?.models, 1);
    assert.equal(JSON.stringify(evidence).includes(directory), false);
    await writeFile(join(pricing, `rates-${snapshot.modelsSha256}.json`), '{}');
    await assert.rejects(absentPriceEvidence(['grok-4.6']), /Invalid price table checksum/);
  } finally {
    if (previous === undefined) delete process.env.SESSION_ANALYTICS_DATA_DIR;
    else process.env.SESSION_ANALYTICS_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
