/** Independent local evidence inspection. It does not resolve or calculate rates. */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export async function absentPriceEvidence(models: string[], explicitDirectory?: string) {
  const normalize = (value: string) => value.toLowerCase().replace(/^xai\//, '').replace(/[_.]/g, '-');
  const sha = (value: string) => createHash('sha256').update(value).digest('hex');
  const directory = explicitDirectory ?? join(process.env.SESSION_ANALYTICS_DATA_DIR ?? join(homedir(), 'Library/Application Support/session-analytics'), 'pricing');
  const seen = new Set<string>();
  const observations: Array<{ source: string; fetchedAt: string; payloadSha256: string; models: number }> = [];
  let files: string[];
  try { files = await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') files = []; else throw error; }
  for (const name of files.sort()) {
    if (!/^(models\.dev|litellm|reviewed)-[\dT-]+-[a-f0-9]{64}\.json$/.test(name)) continue;
    const envelope = JSON.parse(await readFile(join(directory, name), 'utf8')), snapshot = envelope.snapshot;
    if (!['models.dev', 'litellm', 'reviewed'].includes(snapshot.source) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(snapshot.fetchedAt) ||
      !/^[a-f0-9]{64}$/.test(snapshot.payloadSha256)) throw new Error('Invalid price metadata');
    if (sha(JSON.stringify(snapshot)) !== envelope.checksum || !name.endsWith(`-${envelope.checksum}.json`)) throw new Error('Invalid price evidence checksum');
    let table = snapshot.models ?? snapshot.card?.models;
    if (envelope.storageVersion === 2) {
      if (!/^[a-f0-9]{64}$/.test(snapshot.modelsSha256)) throw new Error('Invalid price evidence reference');
      const payload = await readFile(join(directory, `rates-${snapshot.modelsSha256}.json`), 'utf8');
      if (sha(payload) !== snapshot.modelsSha256) throw new Error('Invalid price table checksum');
      table = JSON.parse(payload);
    }
    if (!table || typeof table !== 'object' || Array.isArray(table)) throw new Error('Missing price evidence table');
    for (const model of Object.keys(table)) seen.add(normalize(model));
    observations.push({ source: snapshot.source, fetchedAt: snapshot.fetchedAt, payloadSha256: snapshot.payloadSha256, models: Object.keys(table).length });
  }
  const bundled = JSON.parse(await readFile(new URL('../../data/rate-cards.json', import.meta.url), 'utf8'));
  for (const model of Object.keys(bundled.models)) seen.add(normalize(model));
  return { observations, missingModels: models.filter(model => !seen.has(normalize(model))), checksumVerified: true };
}
