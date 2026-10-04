// Synthetic-only patch verification. This is not an independent data oracle.
import { mkdtemp, cp, symlink, readdir, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const target = await mkdtemp(join(tmpdir(), 'v-pricing-proposals-'));
const output = join(root, '.lane', 'proposal-check');
await mkdir(output, { recursive: true });
for (const name of ['src', 'test', 'data', 'schemas', 'scripts', 'skills', 'docs', 'bin', 'assets',
  'package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'CHANGELOG.md',
  'CODE_OF_CONDUCT.md', 'CONTRIBUTING.md', 'LICENSE', 'SECURITY.md']) {
  await cp(join(root, name), join(target, name), { recursive: true });
}
await symlink(join(root, 'node_modules'), join(target, 'node_modules'), 'dir');
await writeFile(join(output, 'temporary-copy.txt'), target + '\n');

async function run(label, command, args) {
  const result = spawnSync(command, args, { cwd: target, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  await writeFile(join(output, label + '.log'), (result.stdout ?? '') + (result.stderr ?? ''));
  console.log(JSON.stringify({ check: label, exitCode: result.status, signal: result.signal }));
  if (result.error || result.status !== 0) process.exit(1);
}
const patches = (await readdir(join(root, '.lane/fixes'))).filter((name) => name.endsWith('.patch')).sort();
for (const name of patches) {
  await run('apply-' + name, 'patch', ['-p1', '--batch', '--forward', '-i', join(root, '.lane/fixes', name)]);
}
await run('typecheck', 'npm', ['run', 'typecheck']);
const regressions = (await readdir(join(target, 'test/validation')))
  .filter((name) => /^pricing-.*\.test\.ts$/.test(name)).sort().map((name) => 'test/validation/' + name);
await run('regressions', process.execPath, ['--test', '--test-concurrency=2', ...regressions]);
if (process.argv.includes('--full')) {
  const tests = (await readdir(join(target, 'test'))).filter((name) => name.endsWith('.test.ts')).sort()
    .map((name) => 'test/' + name);
  await run('existing-suite', process.execPath, ['--test', '--test-concurrency=1', ...tests]);
}
