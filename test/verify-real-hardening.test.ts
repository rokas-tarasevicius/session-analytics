import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inspectOracleResults } from '../scripts/verify-real-results.ts';
import { copyPricingEvidence, requireUnchangedProduction, resetOracleArtifacts, validateOracleExecution } from '../scripts/verify-real-evidence.ts';
import { auditAbsentAdapters } from '../verify/other-providers/adapters-oracle.ts';

test('oracle difference counters cannot be negative, fractional or cancel missing rows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'verify-counts-'));
  try {
    await mkdir(join(directory, 'repos/.lane'), { recursive: true });
    for (const value of [-1, .5]) {
      await writeFile(join(directory, 'repos/.lane/repos-oracle.json'), JSON.stringify({ mismatches: { sessions: value }, missing: [{}] }));
      const result = (await inspectOracleResults(directory, ['repos']))[0]!;
      assert.equal(result.unresolved, 1);
      assert.equal(result.checks[0]?.unavailable, true);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('explicit supplied snapshot controls raw pricing joins when an old full snapshot exists', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'verify-selected-snapshot-'));
  try {
    await mkdir(join(directory, 'pricing/.lane'), { recursive: true });
    await mkdir(join(directory, 'codex/.lane'), { recursive: true });
    const sessionKey = 'aaaaaaaaaaaa', model = 'gpt-6-sol';
    await mkdir(join(directory,'pricing-evidence'));
    const rateCard={pricing:{snapshots:0,newestSnapshotAt:null,sources:['models.dev','litellm'].map(source=>({source,fetchedAt:null,payloadSha256:null,models:0}))}};
    const cost = { inputUsd: 1, cachedInputUsd: 0, cacheWriteUsd: 0, outputUsd: 0, totalUsd: 1, upperEstimateUsd: 1 };
    await writeFile(join(directory, 'pricing/.lane/pricing-snapshot-oracle.json'), JSON.stringify({ mismatches: [], rawRequestPricingRequired: [{ sessionKey, model }] }));
    await writeFile(join(directory, 'codex/.lane/codex-current.json'), JSON.stringify({ excludedLive: [], retained: [{ key: sessionKey, model, live: false, cost }] }));
    await writeFile(join(directory, 'full.json'), JSON.stringify({ rateCard, sessions: [{ sessionKey, models: [{ model, ...cost, totalUsd: 9 }] }] }));
    const selected = join(directory, 'supplied.json');
    await writeFile(selected, JSON.stringify({ rateCard, sessions: [{ sessionKey, models: [{ model, ...cost }] }] }));
    assert.equal((await inspectOracleResults(directory, ['pricing'], selected))[0]?.unresolved, 0);
    assert.equal((await inspectOracleResults(directory, ['pricing']))[0]?.unresolved, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('fresh oracle workspace removes stale generated artifacts and preserves sibling inputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'verify-artifact-freshness-'));
  try {
    await mkdir(join(directory, '.lane'));
    await writeFile(join(directory, '.lane/old-oracle.json'), '{"differences":[]}');
    await writeFile(join(directory, 'input.json'), '{}');
    await resetOracleArtifacts(directory);
    await assert.rejects(readFile(join(directory, '.lane/old-oracle.json')), { code: 'ENOENT' });
    assert.equal(await readFile(join(directory, 'input.json'), 'utf8'), '{}');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('verification rejects production changes after the initial fingerprint', () => {
  requireUnchangedProduction('a'.repeat(64), 'a'.repeat(64));
  assert.throws(() => requireUnchangedProduction('a'.repeat(64), 'b'.repeat(64)), /changed during verification/);
  assert.throws(() => requireUnchangedProduction('', ''), /changed during verification/);
});

test('recheck requires the complete command manifest and derives failures from exit codes', () => {
  const manifest = [{ file: 'area/first.mjs' }, { file: 'area/second.mjs' }];
  const commands = manifest.map(step => ({ ...step, exitCode: 0, milliseconds: 1 }));
  const valid = { area: 'area', commands, failedCommands: 0 };
  assert.deepEqual(validateOracleExecution(valid, 'area', manifest), valid);
  assert.throws(() => validateOracleExecution({ area: 'area', commands }, 'area', manifest), /status disagrees/);
  assert.throws(() => validateOracleExecution({ ...valid, failedCommands: -1 }, 'area', manifest), /status disagrees/);
  assert.throws(() => validateOracleExecution({ ...valid, commands: commands.slice(0, 1) }, 'area', manifest), /Complete oracle command evidence/);
  assert.throws(() => validateOracleExecution({ ...valid, commands: [...commands].reverse() }, 'area', manifest), /Valid oracle command evidence/);
  const failed = { ...valid, commands: [{ ...commands[0], exitCode: 1 }, commands[1]], failedCommands: 0 };
  assert.throws(() => validateOracleExecution(failed, 'area', manifest), /status disagrees/);
  assert.equal(validateOracleExecution({ ...failed, failedCommands: 1 }, 'area', manifest).failedCommands, 1);
});

test('optional provider absence requires all providers and zero raw and snapshot populations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'verify-provider-census-'));
  try {
    await mkdir(join(directory, 'other-providers/.lane'), { recursive: true });
    const path = join(directory, 'other-providers/.lane/adapters-oracle.json');
    const providers = ['copilot', 'gemini', 'opencode'].map(provider => ({ provider, historyFiles: 0, referenceSessions: 0 }));
    const check = async (rows: unknown[], status = 'verified-empty-population') => {
      await writeFile(path, JSON.stringify({ status, providers: rows }));
      return (await inspectOracleResults(directory, ['other-providers']))[0]!.checks.find(c => c.check === 'optional-provider-history-absence-confirmed')!;
    };
    assert.equal((await check(providers)).differences, 0);
    assert.equal((await check([])).unavailable, true);
    assert.equal((await check([providers[0], providers[0], providers[2]])).unavailable, true);
    assert.equal((await check([{ ...providers[0], referenceSessions: 1 }, ...providers.slice(1)])).differences, 1);
    assert.equal((await check(providers, 'requires-populated-history-reconciliation')).differences, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('pricing evidence stays immutable and can be copied from a nested previous audit cache', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'verify-pricing-copy-'));
  try {
    const source = join(directory, 'source'), destination = join(directory, 'evidence');
    await mkdir(source); await writeFile(join(source, 'observation.json'), '{"rate":1}');
    await copyPricingEvidence(source, destination);
    await writeFile(join(source, 'observation.json'), '{"rate":9}');
    assert.equal(await readFile(join(destination, 'observation.json'), 'utf8'), '{"rate":1}');
    const nested = join(destination, 'pricing'); await mkdir(nested);
    await writeFile(join(nested, 'nested.json'), '{"rate":2}');
    await copyPricingEvidence(nested, destination);
    assert.equal(await readFile(join(destination, 'nested.json'), 'utf8'), '{"rate":2}');
    await assert.rejects(readFile(join(destination, 'observation.json')), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unreadable optional-provider ancestors cannot be certified as missing history', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'verify-unreadable-'));
  const parent = join(directory, '.copilot'), snapshot = join(directory, 'snapshot.json');
  await mkdir(join(parent, 'session-state'), { recursive: true });
  await writeFile(snapshot, '{"sessions":[]}');
  try {
    assert.equal(auditAbsentAdapters(snapshot, directory, {}).status, 'verified-empty-population');
    await chmod(parent, 0);
    assert.throws(() => auditAbsentAdapters(snapshot, directory, {}), { code: 'EACCES' });
  } finally { await chmod(parent, 0o700); await rm(directory, { recursive: true, force: true }); }
});

test('pricing input rejects a parent directory with nested pricing rather than silently losing feeds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'verify-pricing-shape-'));
  try {
    await mkdir(join(directory,'input/pricing'),{recursive:true});
    await writeFile(join(directory,'input/pricing/evidence.json'),'{}');
    await assert.rejects(copyPricingEvidence(join(directory,'input'),join(directory,'output')),/pricing child/);
    await copyPricingEvidence(join(directory,'input/pricing'),join(directory,'output'));
    assert.equal(await readFile(join(directory,'output/evidence.json'),'utf8'),'{}');
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('phase pricing provenance cannot claim absent observations when copied feeds exist',async()=>{
  const {createHash}=await import('node:crypto');
  const {verifyPricingProvenance}=await import('../scripts/verify-real-evidence.ts');
  const directory=await mkdtemp(join(tmpdir(),'verify-price-provenance-'));
  try{
    const snapshot={version:1,source:'models.dev',fetchedAt:'2026-10-03T11:45:52.605Z',payloadSha256:'a'.repeat(64),models:{fixture:{input:1}}};
    const checksum=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
    await writeFile(join(directory,`models.dev-2026-10-03T114552605-${checksum}.json`),JSON.stringify({checksum,snapshot}));
    const pricing={snapshots:1,newestSnapshotAt:snapshot.fetchedAt,sources:[{source:'models.dev',fetchedAt:snapshot.fetchedAt,payloadSha256:snapshot.payloadSha256,models:1},{source:'litellm',fetchedAt:null,payloadSha256:null,models:0}]};
    assert.deepEqual(await verifyPricingProvenance({rateCard:{pricing}},directory),[]);
    assert.ok((await verifyPricingProvenance({rateCard:{pricing:{...pricing,snapshots:0,sources:pricing.sources.map(s=>({...s,fetchedAt:null,payloadSha256:null,models:0}))}}},directory)).length>0);
  }finally{await rm(directory,{recursive:true,force:true});}
});
