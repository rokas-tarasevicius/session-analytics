import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { indexStatus, openIndexDatabase } from "../src/store/database.ts";
import { indexErrorCode } from "../src/store/errors.ts";

const databaseModule = new URL("../src/store/database.ts", import.meta.url).href;
const gateModule = new URL("../src/store/writer-gate.ts", import.meta.url).href;
function child(source: string, dataDir: string) {
  const process = spawn(globalThis.process.execPath, ["--input-type=module", "-e", source, dataDir], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  process.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4096); });
  const exited = once(process, "exit");
  return { process, exited, stderr: () => stderr };
}

/** Every contender exits 0; a failure names the contender's own error instead of a bare exit code. */
async function allSucceed(children: Array<ReturnType<typeof child>>): Promise<void> {
  const codes = await Promise.all(children.map(({ exited }) => exited));
  codes.forEach(([code], index) => assert.equal(code, 0, `contender ${index} exited ${code}: ${children[index]!.stderr().trim() || "(no stderr)"}`));
}

async function stop(running: ReturnType<typeof child> | undefined): Promise<void> {
  if (!running || running.process.exitCode !== null || running.process.signalCode !== null) return;
  const fallback = setTimeout(() => running.process.kill("SIGKILL"), 1000);
  running.process.kill("SIGTERM");
  try { await running.exited; } finally { clearTimeout(fallback); }
}

test("writer filesystem mutex serializes simultaneous contenders independently of SQLite", { timeout: 20_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "index-gate-test-"));
  try {
    const source = `import {acquireWriterGate} from ${JSON.stringify(gateModule)};
      import {openSync,closeSync,unlinkSync} from 'node:fs'; import {join} from 'node:path';
      const dir=process.argv[1], marker=join(dir,'critical');
      for(let i=0;i<20;i++){ const release=acquireWriterGate(dir);
        const fd=openSync(marker,'wx'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2);
        closeSync(fd); unlinkSync(marker); release(); }`;
    const children = Array.from({ length: 8 }, () => child(source, dataDir));
    await allSucceed(children);
    assert.deepEqual(await readdir(dataDir), []);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("concurrent rebuilds quarantine corrupt writer coordination once under mutual exclusion", { timeout: 20_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "index-recovery-test-"));
  try {
    openIndexDatabase({ dataDir }).close();
    await writeFile(join(dataDir, "writer.sqlite"), "synthetic-coordination-corruption");
    assert.equal(indexStatus({ dataDir }).state, "corrupt");
    assert.throws(() => openIndexDatabase({ dataDir }), (error) => indexErrorCode(error) === "index-coordination");
    const source = `import {resetIndex,openIndexDatabase} from ${JSON.stringify(databaseModule)};
      const opts={dataDir:process.argv[1]}; resetIndex(opts); openIndexDatabase(opts).close();`;
    const children = Array.from({ length: 4 }, () => child(source, dataDir));
    await allSucceed(children);
    assert.equal(indexStatus({ dataDir }).state, "ready");
    assert.equal((await readdir(dataDir)).filter((name) => /^writer.sqlite.rebuild-/.test(name)).length, 1);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("a killed writer releases SQLite and its abandoned filesystem ticket can be recovered", { timeout: 15_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "index-killed-writer-"));
  let running: ReturnType<typeof child> | undefined;
  try {
    running = child(`import {openIndexDatabase} from ${JSON.stringify(databaseModule)};
      const db=openIndexDatabase({dataDir:process.argv[1]}); process.stdout.write('ready'); setInterval(()=>{},1000);`, dataDir);
    await once(running.process.stdout!, "data"); await stop(running);
    openIndexDatabase({ dataDir }).close();
    assert.equal(indexStatus({ dataDir }).state, "ready");
    assert.equal((await readdir(dataDir)).some((name) => name.startsWith("writer-ticket-")), false);
  } finally { await stop(running); await rm(dataDir, { recursive: true, force: true }); }
});
