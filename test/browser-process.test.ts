import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stopBrowserProcess } from "./browser-process.ts";

const ownerSource = `
  const fs = require('node:fs');
  const path = require('node:path');
  const profile = process.argv[1];
  fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
  setInterval(() => fs.writeFileSync(path.join(profile, 'Default', 'state'), 'synthetic'), 10);
  process.on('SIGTERM', () => {
    fs.writeFileSync(path.join(profile, 'term'), 'received');
    if (process.argv[2] === 'delayed') setTimeout(() => process.exit(0), 50);
  });
  process.on('message', message => { if (message === 'close') process.exit(0); });
  process.send('ready');
`;

for (const mode of ["delayed", "resistant", "graceful"] as const) {
  test(`browser cleanup waits for a ${mode} profile owner to close`, { timeout: 5_000 }, async (t) => {
    const profile = await mkdtemp(join(tmpdir(), "browser-process-test-"));
    const child = spawn(process.execPath, ["-e", ownerSource, profile, mode], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    t.after(async () => { await stopBrowserProcess(child, undefined, { graceMs: 100, killMs: 1_000 }); await rm(profile, { recursive: true, force: true }); });
    let closed = false;
    child.once("close", () => { closed = true; });
    await once(child, "message");
    const request = mode === "graceful" ? () => new Promise<void>((resolve, reject) => {
      child.send("close", (error) => error ? reject(error) : resolve());
    }) : undefined;
    await stopBrowserProcess(child, request, { graceMs: mode === "resistant" ? 100 : 1_000, killMs: 1_000 });
    assert.equal(closed, true, "deletion cannot start while the profile owner remains alive");
    if (mode === "resistant") assert.equal(child.signalCode, "SIGKILL", "a SIGTERM-resistant owner is forcibly stopped and reaped");
    else assert.equal(child.exitCode, 0, "graceful shutdown is allowed to finish");
    assert.equal(existsSync(join(profile, "term")), mode !== "graceful", "the protocol shutdown runs before signal fallback");
    await rm(profile, { recursive: true });
  });
}
