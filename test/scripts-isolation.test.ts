import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("test wrapper overrides an inherited private data directory and cleans up its own writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-analytics-wrapper-"));
  try {
    for (const dir of ["scripts", "test/validation", "verify", "temporary", "private-data"]) await mkdir(join(root, dir), { recursive: true });
    await copyFile(new URL("../scripts/test.ts", import.meta.url), join(root, "scripts/test.ts"));
    await writeFile(join(root, "private-data/sentinel"), "preserve");
    await writeFile(join(root, "test/isolation.test.ts"), `
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const data = process.env.SESSION_ANALYTICS_DATA_DIR;
assert.ok(data && data.startsWith(process.env.TMPDIR + "/"));
assert.notEqual(data, process.env.INHERITED_DATA_DIR);
mkdirSync(data, { recursive: true });
writeFileSync(join(data, "derived-index"), "synthetic");
`);
    const result = spawnSync(process.execPath, [join(root, "scripts/test.ts")], { encoding: "utf8", timeout: 30_000,
      env: { ...process.env, TMPDIR: join(root, "temporary"), SESSION_ANALYTICS_DATA_DIR: join(root, "private-data"), INHERITED_DATA_DIR: join(root, "private-data") } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(await readdir(join(root, "temporary")), [], "the wrapper removes its derived data");
    assert.deepEqual(await readdir(join(root, "private-data")), ["sentinel"]);
    assert.equal(await readFile(join(root, "private-data/sentinel"), "utf8"), "preserve");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("demo index benchmark excludes provider history in the caller's home", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "session-analytics-benchmark-isolation-"));
  try {
    const source = join(root, "home/.copilot/session-state/private-session/events.jsonl");
    await mkdir(join(root, "home/.copilot/session-state/private-session"), { recursive: true });
    await mkdir(join(root, "demo"));
    const record = JSON.stringify({ id: "private-start", type: "session.start", timestamp: "2026-07-20T12:00:00Z",
      data: { sessionId: "private-session", startTime: "2026-07-20T12:00:00Z", context: { cwd: root } } }) + "\n";
    await writeFile(source, record);
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/benchmark-index.ts", import.meta.url)), "--demo-root", join(root, "demo")], {
      encoding: "utf8", timeout: 55_000, env: { ...process.env, HOME: join(root, "home"), XDG_DATA_HOME: join(root, "home/.local/share") },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.parityVerified, true);
    assert.equal(report.sessionsCold, 0);
    assert.equal(report.sessionsWarm, 0);
    assert.equal(await readFile(source, "utf8"), record);
  } finally { await rm(root, { recursive: true, force: true }); }
});
