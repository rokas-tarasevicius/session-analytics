/** Audit-workspace isolation only; never touches provider histories. */
import { cp, mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { OracleStep } from './verify-real-manifest.ts';

export async function resetOracleArtifacts(workspace: string): Promise<void> {
  const artifacts = join(workspace, '.lane');
  await rm(artifacts, { recursive: true, force: true });
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
}

export async function copyPricingEvidence(source: string, destination: string): Promise<void> {
  if (resolve(source) === resolve(destination)) return;
  if (resolve(destination).startsWith(resolve(source) + sep)) throw new Error('Pricing copy cannot contain its source.');
  await mkdir(dirname(destination), { recursive: true });
  const staged = await mkdtemp(join(dirname(destination), '.pricing-evidence-'));
  try {
    let present = true;
    try { await stat(source); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') present = false; else throw error; }
    if (present) {
      let nested = false; try { nested = (await stat(join(source, 'pricing'))).isDirectory(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (nested) throw new Error('Pricing input is a data directory; select its pricing child.');
      await cp(source, staged, { recursive: true });
    }
    await rm(destination, { recursive: true, force: true });
    await rename(staged, destination);
  } finally { await rm(staged, { recursive: true, force: true }); }
}

export function requireUnchangedProduction(expected: string, actual: string): void {
  if (!/^[a-f0-9]{64}$/.test(expected) || actual !== expected) throw new Error('Production source changed during verification.');
}

export function validateOracleExecution(value: unknown, area: string, expected: Pick<OracleStep, 'file'>[]) {
  const record = value as Record<string, unknown> | null;
  if (!record || record['area'] !== area || !Array.isArray(record['commands']) || record['commands'].length !== expected.length) {
    throw new Error('Complete oracle command evidence is unavailable.');
  }
  const commands = record['commands'].map((command: unknown, index) => {
    const row = command as Record<string, unknown> | null;
    if (!row || row['file'] !== expected[index]!.file || typeof row['exitCode'] !== 'number' ||
      !Number.isSafeInteger(row['exitCode']) || row['exitCode'] < 0 || row['exitCode'] > 255 ||
      typeof row['milliseconds'] !== 'number' || !Number.isSafeInteger(row['milliseconds']) || row['milliseconds'] < 0) {
      throw new Error('Valid oracle command evidence is unavailable.');
    }
    return { file: expected[index]!.file, exitCode: row['exitCode'], milliseconds: row['milliseconds'] };
  });
  const failedCommands = commands.filter(command => command.exitCode !== 0).length;
  if (record['failedCommands'] !== failedCommands) throw new Error('Oracle command status disagrees with its evidence.');
  return { area, commands, failedCommands };
}

/** Bind every analyzer phase to independently checksum-verified copied observations. */
export async function verifyPricingProvenance(snapshot: Record<string, any>, directory: string): Promise<string[]> {
  const { absentPriceEvidence } = await import('../verify/other-providers/price-evidence.ts');
  const { observations } = await absentPriceEvidence([], directory);
  const feeds = observations.filter(s => s.source !== 'reviewed');
  const pricing = snapshot['rateCard']?.pricing;
  if (!pricing || !Array.isArray(pricing.sources)) return ['pricing.unavailable'];
  const failures: string[] = [];
  const latest = new Map<string, (typeof feeds)[number]>();
  for (const source of feeds) if (!latest.has(source.source) || source.fetchedAt > latest.get(source.source)!.fetchedAt) latest.set(source.source, source);
  for (const source of ['models.dev', 'litellm']) {
    const expected = latest.get(source), actual = pricing.sources.filter((s: Record<string, any>) => s.source === source);
    if (actual.length !== 1) { failures.push(`${source}.multiplicity`); continue; }
    for (const field of ['fetchedAt','payloadSha256','models'] as const) {
      const wanted = expected?.[field] ?? (field === 'models' ? 0 : null);
      if (actual[0][field] !== wanted) failures.push(`${source}.${field}`);
    }
  }
  if (pricing.snapshots !== feeds.length) failures.push('pricing.snapshots');
  const newest = feeds.map(s=>s.fetchedAt).sort().at(-1) ?? null;
  if (pricing.newestSnapshotAt !== newest) failures.push('pricing.newestSnapshotAt');
  return failures;
}
