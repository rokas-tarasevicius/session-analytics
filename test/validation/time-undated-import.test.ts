import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { analyzeMachineSessions } from '../../src/analyzer.ts';
import { validateSnapshot } from '../../src/interop/snapshot.ts';
import { filterSnapshot } from '../../src/public/export-data.js';
import type { MachineAnalytics } from '../../src/types.ts';
import { createSessionAnalyticsFixture } from '../fixtures.ts';

let directory: string;
let snapshot: MachineAnalytics;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'time-undated-import-'));
  const fixture = await createSessionAnalyticsFixture(directory);
  const [project] = await readdir(fixture.claudeRoot);
  assert.ok(project);
  const filename = (await readdir(join(fixture.claudeRoot, project))).find(name => name.endsWith('.jsonl'));
  assert.ok(filename);
  const file = join(fixture.claudeRoot, project, filename);
  const records = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
  for (const record of records) if (record['type'] === 'assistant') delete record['timestamp'];
  await writeFile(file, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const { repositoryRoot: _root, remote: _remote, ...options } = fixture;
  snapshot = filterSnapshot(await analyzeMachineSessions({ ...options, pricingPolicy: 'reviewed-only' }), { providers: ['claude'] });
  const session = snapshot.sessions[0];
  assert.ok(session?.velocity);
  const undatedUsd = session.velocity.undated.reduce((total, [, values]) => total + values[0], 0);
  const datedUsd = session.velocity.buckets.reduce((total, [, , , values]) => total + values[0], 0);
  assert.ok(undatedUsd > 0 && datedUsd > 0, 'fixture retains both dated child and undated parent API usage');
  assert.ok(Math.abs(undatedUsd + datedUsd - session.cost.totalUsd) < 1e-12);
  // Expected projection after TIME-CODEX-UNDATED: remove the manufactured date
  // while retaining the independently evidenced undated velocity counters.
  session.spendByDay = { '2026-07-20': datedUsd };
  snapshot = filterSnapshot(snapshot);
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

test('snapshot import accepts API value reconciled by dated spend plus explicit undated usage', () => {
  assert.doesNotThrow(() => validateSnapshot(snapshot));
});

test('snapshot import rejects missing dated value with no explicit undated evidence', () => {
  const value = structuredClone(snapshot);
  delete value.sessions[0]!.velocity;
  assert.throws(() => validateSnapshot(value));
});

test('snapshot import rejects a fabricated undated amount even when dated spend is adjusted to compensate', () => {
  const value = structuredClone(snapshot);
  const session = value.sessions[0]!;
  session.velocity!.undated[0]![1][0] += 0.0001;
  session.spendByDay['2026-07-20']! -= 0.0001;
  assert.throws(() => validateSnapshot(filterSnapshot(value)));
});

test('snapshot import rejects undated usage counters that no longer reconcile with model usage', () => {
  const value = structuredClone(snapshot);
  value.sessions[0]!.velocity!.undated[0]![1][1] += 1;
  assert.throws(() => validateSnapshot(value));
});
