import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { promisify } from "node:util";
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
    for (const path of ["export-data.js", "export-menu.js", "shared-view.js", "evidence.js", "timestamps.js", "interop.css"]) assert.equal((await fetch(`${origin}/${path}`)).status, 200);
    const page = await (await fetch(origin)).text(); assert.match(page, /id="export-menu"/); assert.match(page, /id="shared-snapshot"/);
    for (const field of ["warning", "status", "repository"]) {
      const bad = structuredClone(snapshot);
      if (field === "warning") bad.warnings.push("EACCES /private/secret-path");
      if (field === "status") Object.assign(bad.sessions[0]!, { status: "secret-command --token=secret" });
      if (field === "repository") {
        const id = bad.repositories[0]!.repository.id;
        bad.repositories[0]!.repository.id = "11111111-2222-4333-8444-555555555555";
        for (const session of bad.sessions) if (session.repositoryId === id) session.repositoryId = bad.repositories[0]!.repository.id;
      }
      await writeFile(path, JSON.stringify(bad));
      const response = await get("?refresh=1"); assert.equal(response.status, 502);
      assert.doesNotMatch(await response.text(), /secret|11111111-2222/);
    }
    await writeFile(path, '{"prompt":"secret-command"}');
    const bad = await get("?refresh=1"); assert.equal(bad.status, 502);
    const text = await bad.text(); assert.match(text, /snapshot file is invalid/i); assert.doesNotMatch(text, /secret|rate card/i);
    const collision = spawn(process.execPath, [server, "--snapshot", path, "--port", String(serverPort)], { stdio: "ignore" });
    assert.equal((await once(collision, "exit"))[0], 1, "a file dashboard must not reuse a server showing different data");
    assert.equal((await fetch(`${origin}/api/analytics`, { method: "POST" })).status, 405);
  } finally { if (child) await stop(child); await rm(directory, { recursive: true, force: true }); }
});

test("review: live and saved dashboards cannot reuse each other's ports", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "interop-source-"));
  let child: ChildProcess | undefined;
  const server = new URL("../src/server.ts", import.meta.url).pathname;
  try {
    const { repositoryRoot, remote, ...options } = await createSessionAnalyticsFixture(directory);
    const full = await analyzeMachineSessions(options);
    const path = join(directory, "saved.json");
    // Explicit fixture roots keep every live-mode test isolated from real history.
    const flags = ["--database", options.databasePath, "--claude-root", options.claudeRoot, "--codex-root", options.codexRoot, "--codex-archive-root", options.codexArchiveRoot, "--cursor-database", options.cursorDatabasePath];
    for (const snapshot of [full, shareSnapshot(full, Buffer.alloc(32, 7), 2), null]) {
      await writeFile(path, JSON.stringify(snapshot ?? full));
      const serverPort = await port(), origin = `http://127.0.0.1:${serverPort}`;
      child = spawn(process.execPath, [server, "--no-open", "--port", String(serverPort), ...(snapshot ? ["--snapshot", path] : flags)], { stdio: ["ignore", "pipe", "pipe"] });
      let output = ""; child.stdout!.on("data", (chunk) => { output += chunk; });
      for (let i = 0; !output.includes("ready:") && i < 200; i++) await delay(20);
      assert.match(output, /ready:/);
      const caller = snapshot ? flags : ["--snapshot", path];
      await assert.rejects(promisify(execFile)(process.execPath, [server, "--no-open", "--port", String(serverPort), ...caller]));
      const health = await (await fetch(`${origin}/api/health`)).json() as any;
      assert.equal(health.dataSource, snapshot ? "snapshot" : "live");
      assert.doesNotMatch(JSON.stringify(health), /saved\.json|interop-source/);
      if (!snapshot) await promisify(execFile)(process.execPath, [server, "--no-open", "--port", String(serverPort), ...flags]);
      await stop(child); child = undefined;
    }
  } finally { if (child) await stop(child); await rm(directory, { recursive: true, force: true }); }
});
