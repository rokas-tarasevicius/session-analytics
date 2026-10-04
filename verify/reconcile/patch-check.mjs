// Review-only verification: apply inert proposals to a fresh temporary copy.
// This script never changes this checkout's production source or git state.
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');
const scratch = mkdtempSync(join(tmpdir(), 'reconcile-patches-'));
const tests = readdirSync(join(root, 'test/validation')).filter(name => /^reconcile-.*\.test\.ts$/.test(name)).sort().map(name => `test/validation/${name}`);
const patches = ['RC-CODEX-01', 'RC-CODEX-02', 'RC-CONDUCTOR-REPLAY', 'RC-CONDUCTOR-LOCAL', 'RC-MODEL-01'];
const clean = value => value.replaceAll(scratch, '<temporary-validation>').replaceAll(root, '<workspace>');
function run(command, args, cwd, artifact) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 300_000 });
  const output = clean((result.stdout ?? '') + (result.stderr ?? '') + (result.error ? String(result.error) : ''));
  writeFileSync(join(root, '.lane', artifact), output, { mode: 0o600 });
  return { status: result.status, error: Boolean(result.error) };
}
try {
  const original = run(process.execPath, ['--test', '--test-concurrency=1', ...tests], root, 'validation-original.log');
  for (const name of readdirSync(root)) {
    if (['.git', '.lane', 'node_modules', 'verify'].includes(name)) continue;
    cpSync(join(root, name), join(scratch, name), { recursive: true });
  }
  if (existsSync(join(root, 'node_modules'))) symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir');
  for (const patch of patches) {
    const result = run('patch', ['-p1', '--batch', '-i', join(root, '.lane/fixes', `${patch}.patch`)], scratch, `patch-apply-${patch}.log`);
    if (result.status !== 0) throw new Error(`Proposal failed to apply: ${patch}`);
  }
  const patched = run(process.execPath, ['--test', '--test-concurrency=1', ...tests], scratch, 'combined-patch-tests.log');
  const typecheck = run(join(root, 'node_modules/.bin/tsc'), ['--noEmit'], scratch, 'combined-patch-typecheck.log');
  const numericReplay = run(process.execPath, ['verify/reconcile/conductor-replay.mjs', join(scratch, 'src/providers/conductor.ts')], root, 'combined-patch-numeric-replay.log');
  console.log(JSON.stringify({ original, patched, typecheck, numericReplay, testFiles: tests.length, patches: patches.length }));
  if (patched.status !== 0 || typecheck.status !== 0 || numericReplay.status !== 0) process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
