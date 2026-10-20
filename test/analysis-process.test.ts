import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("analysis worker failures cross the pipe only as fixed messages", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "analysis-process-"));
  try {
    const worker = join(root, "worker.mjs"), probe = join(root, "probe.mjs");
    await writeFile(worker, `const mode = process.argv[2];
if (mode === "closed-input") process.exit(1);
for await (const chunk of process.stdin) {}
if (mode === "nonzero") { process.stderr.write("PRIVATE-WORKER-SENTINEL"); process.exitCode = 1; }
if (mode === "partial") process.stdout.write('{"PRIVATE-WORKER-SENTINEL":');
if (mode === "heap") { process.stderr.write("FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory PRIVATE-WORKER-SENTINEL"); process.exitCode = 1; }
if (mode === "serialization") { process.stdout.write("{"); process.stderr.write("heap out of memory PRIVATE-WORKER-SENTINEL"); process.exitCode = 1; }
`);
    await writeFile(probe, `import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const spawn = childProcess.spawn, mode = process.argv[2];
childProcess.spawn = (_command, _args, options) => mode === "spawn-error"
  ? spawn(${JSON.stringify(join(root, "PRIVATE-WORKER-SENTINEL"))}, [], options)
  : spawn(process.execPath, [${JSON.stringify(worker)}, mode], options);
syncBuiltinESMExports();
const { analyzeMachineSessionsIsolated } = await import(${JSON.stringify(new URL("../src/analysis-process.ts", import.meta.url).href)});
try {
  await analyzeMachineSessionsIsolated({ dataDir: "x".repeat(2 * 1024 * 1024) });
  process.exitCode = 1;
} catch (error) {
  process.stdout.write(JSON.stringify({ message: error.message, stage: error.stage }));
}
`);
    for (const [mode, message, stage] of [
      ["nonzero", "Session analysis process exited before returning a result.", undefined],
      ["partial", "Session analysis process returned an invalid result.", undefined],
      ["heap", "Session analysis exceeded its 1024 MB worker heap limit.", "analysis"],
      ["serialization", "Session analysis exceeded its 1024 MB worker heap limit.", "serialization"],
      ["closed-input", "Session analysis process exited before returning a result.", undefined],
      ["spawn-error", "Session analysis process could not be started.", undefined],
    ]) {
      await t.test(mode!, () => {
        const result = spawnSync(process.execPath, [probe, mode!], { encoding: "utf8", timeout: 5_000 });
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), { message, ...(stage ? { stage } : {}) });
        assert.equal(result.stderr, "");
      });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
