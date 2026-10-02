import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { analyzeMachineSessions } from "../src/analyzer.ts";
import { shareSnapshot } from "../src/interop/sharing.ts";
import { createSessionAnalyticsFixture } from "./fixtures.ts";

async function port(): Promise<number> {
  const server = createServer(); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve) => server.close(() => resolve())); return address.port;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
}

test("file dashboard serves full and shared snapshots, re-reads on refresh, and never falls back to discovery", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "interop-server-"));
  let child: ChildProcess | undefined;
  try {
    const fixture = await createSessionAnalyticsFixture(directory);
    const { repositoryRoot, remote, ...options } = fixture;
    const snapshot = await analyzeMachineSessions(options);
    const path = join(directory, "snapshot.json"); await writeFile(path, JSON.stringify(snapshot));
    const serverPort = await port(), origin = `http://127.0.0.1:${serverPort}`;
    const server = new URL("../src/server.ts", import.meta.url).pathname;
    child = spawn(process.execPath, [server, "--snapshot", path, "--port", String(serverPort)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SESSION_ANALYTICS_RATE_CARD: join(directory, "secret-path-do-not-load.json") },
    });
    let output = ""; child.stdout!.on("data", (chunk) => { output += String(chunk); });
    for (let i = 0; !output.includes("ready:") && i < 200; i++) await delay(20);
    assert.match(output, /ready:/);
    const get = async (suffix = "") => fetch(`${origin}/api/analytics${suffix}`);
    assert.deepEqual(await (await get()).json(), snapshot);
    const replacement = shareSnapshot(snapshot, Buffer.alloc(32, 3), 2);
    await writeFile(path, JSON.stringify(replacement));
    assert.deepEqual(await (await get()).json(), snapshot, "file is cached until refresh");
    assert.deepEqual(await (await get("?refresh=1")).json(), replacement);
    for (const path of ["export-data.js", "export-menu.js", "shared-view.js", "interop.css"]) assert.equal((await fetch(`${origin}/${path}`)).status, 200);
    const page = await (await fetch(origin)).text(); assert.match(page, /id="export-menu"/); assert.match(page, /id="shared-snapshot"/);
    await writeFile(path, '{"prompt":"secret-command"}');
    const bad = await get("?refresh=1"); assert.equal(bad.status, 502);
    const text = await bad.text(); assert.match(text, /snapshot file is invalid/i); assert.doesNotMatch(text, /secret|rate card/i);
    const collision = spawn(process.execPath, [server, "--snapshot", path, "--port", String(serverPort)], { stdio: "ignore" });
    assert.equal((await once(collision, "exit"))[0], 1, "a file dashboard must not reuse a server showing different data");
    assert.equal((await fetch(`${origin}/api/analytics`, { method: "POST" })).status, 405);
  } finally { if (child) await stop(child); await rm(directory, { recursive: true, force: true }); }
});
