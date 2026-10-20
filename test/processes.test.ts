import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

test("signals and closed output stop even a tracked child that ignores SIGTERM", { timeout: 25_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "process-lifecycle-"));
  const probe = join(root, "probe.mjs");
  await writeFile(probe, `import { spawn } from "node:child_process";
import { track, stopOnSignals, stopOnOutputError } from ${JSON.stringify(new URL("../src/processes.ts", import.meta.url).href)};
stopOnSignals();
stopOnOutputError();
const child = track(spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000);'], { stdio: ["ignore", "pipe", "ignore"] }));
child.stdout.once("data", () => process.stdout.write(JSON.stringify({ pid: child.pid }) + "\\n"));
process.stdin.once("data", () => process.stdout.write("report\\n"));
`);
  try {
    for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129], [null, 0]] as const) {
      await t.test(signal ?? "closed output", async () => {
        const child = spawn(process.execPath, [probe], { stdio: ["pipe", "pipe", "pipe"] });
        let workerPid: number | undefined, stderr = "";
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
        const closed = once(child, "close");
        try {
          const [chunk] = await once(child.stdout, "data");
          workerPid = (JSON.parse(String(chunk)) as { pid: number }).pid;
          assert.equal(Number.isInteger(workerPid), true);
          if (signal) child.kill(signal);
          else { child.stdout.destroy(); child.stdin.end("write"); }
          const [status, killed] = await closed;
          assert.equal(killed, null);
          assert.equal(status, code, stderr);
          assert.equal(stderr, "");
          const running = (): boolean => {
            try { process.kill(workerPid!, 0); return true; } catch { return false; }
          };
          const deadline = Date.now() + 2_000;
          while (running() && Date.now() < deadline) await delay(25);
          assert.equal(running(), false, "the tracked child must not be orphaned");
        } finally {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          if (workerPid) { try { process.kill(workerPid, "SIGKILL"); } catch { /* Already stopped. */ } }
        }
      });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
