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
  const exited = once(process, "exit");
  return { process, exited };
}

test("writer filesystem mutex serializes simultaneous contenders independently of SQLite", { timeout: 20_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "index-gate-test-"));
  try {
    const source = `import {acquireWriterGate} from ${JSON.stringify(gateModule)};
      import {openSync,closeSync,unlinkSync} from 'node:fs'; import {join} from 'node:path';
      const dir=process.argv[1], marker=join(dir,'critical');
      for(let i=0;i<5;i++){ const release=acquireWriterGate(dir);
        const fd=openSync(marker,'wx'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
        closeSync(fd); unlinkSync(marker); release(); }`;
    const children = Array.from({ length: 6 }, () => child(source, dataDir));
    for (const [code] of await Promise.all(children.map(({ exited }) => exited))) assert.equal(code, 0);
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
    for (const [code] of await Promise.all(children.map(({ exited }) => exited))) assert.equal(code, 0);
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
    await once(running.process.stdout!, "data"); running.process.kill("SIGKILL"); await running.exited;
    openIndexDatabase({ dataDir }).close();
    assert.equal(indexStatus({ dataDir }).state, "ready");
    assert.equal((await readdir(dataDir)).some((name) => name.startsWith("writer-ticket-")), false);
  } finally { running?.process.kill("SIGKILL"); await rm(dataDir, { recursive: true, force: true }); }
});
