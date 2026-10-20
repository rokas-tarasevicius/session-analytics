import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const demo = fileURLToPath(new URL("../scripts/demo.ts", import.meta.url));

test("demo rejects missing option values before generating data or launching a dashboard", () => {
  for (const args of [["report", "--port"], ["report", "--port", "--keep"], ["report", "--bin"], ["report", "--bin", "--keep"]]) {
    const result = spawnSync(process.execPath, [demo, ...args], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /--(?:port|bin) requires a (?:port|path)/);
    assert.doesNotMatch(result.stderr, /Generated/);
  }
});

test("demo isolates inherited paths, honors --bin and --keep, and seeds repeatable native records", { timeout: 180_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "session-analytics-demo-contract-"));
  try {
    const bin = join(directory, "inspect.mjs"), realData = join(directory, "private-data"), temporary = join(directory, "temporary");
    await mkdir(realData); await mkdir(temporary);
    await writeFile(join(realData, "sentinel"), "PRIVATE_DEMO_TEST_SENTINEL");
    // A stand-in build observes exactly what the demo passes to a real installed bin.
    await writeFile(bin, `
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
const root = dirname(process.env.HOME), digest = createHash("sha256");
const normalize = value => value.replaceAll(root, "<demo>").replaceAll(root.replace(/[/.]/g, "-"), "<demo>");
for (const directory of ["claude/projects", "claude-work/projects", "codex/sessions", "codex/archived_sessions"]) {
  const walk = path => { for (const entry of readdirSync(path, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (entry.name.endsWith(".jsonl")) { digest.update(normalize(relative(root, file))); digest.update(normalize(readFileSync(file, "utf8"))); }
  } };
  walk(join(root, directory));
}
console.log(JSON.stringify({ root, args: process.argv.slice(2), env: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(HOME$|USERPROFILE$|SESSION_ANALYTICS_|CLAUDE_CONFIG_DIR$|CODEX_HOME$|CONDUCTOR_)/.test(key))), digest: digest.digest("hex") }));
`);
    const run = (keep: boolean) => {
      const result = spawnSync(process.execPath, [demo, "report", "--json", "--bin", bin, ...(keep ? ["--keep"] : [])], {
        encoding: "utf8", timeout: 80_000, env: { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
          SESSION_ANALYTICS_DEMO_NOW: "2026-09-30T12:00:00Z", SESSION_ANALYTICS_DEMO_BIN: "/nonexistent/other-build",
          SESSION_ANALYTICS_DATA_DIR: realData, SESSION_ANALYTICS_CLAUDE_ROOT: realData, SESSION_ANALYTICS_REMOTE: "private-host",
          CLAUDE_CONFIG_DIR: realData, CODEX_HOME: realData, CONDUCTOR_DATABASE: join(realData, "history.db") },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return JSON.parse(result.stdout) as { root: string; args: string[]; env: Record<string, string>; digest: string };
    };
    const kept = run(true), cleaned = run(false);
    assert.equal(kept.digest, cleaned.digest, "fixed seed and clock produce identical native JSONL records");
    assert.equal(existsSync(join(kept.root, ".keep")), true);
    assert.equal(existsSync(cleaned.root), false);
    assert.deepEqual(kept.env, { HOME: join(kept.root, "home"), USERPROFILE: join(kept.root, "home"),
      SESSION_ANALYTICS_CLAUDE_EVENT_LOGS: join(kept.root, "home/.t3/userdata/logs/provider"),
      SESSION_ANALYTICS_DATA_DIR: join(kept.root, "analytics-data"), SESSION_ANALYTICS_OFFLINE: "1" });
    assert.equal(kept.args[0], "report");
    assert.ok(kept.args.includes("--no-additional-providers"));
    for (let i = 0; i < kept.args.length; i++) if (/--.*(?:root|database|data-dir)$/.test(kept.args[i]!)) assert.ok(kept.args[i + 1]!.startsWith(`${kept.root}/`), kept.args[i]);
    assert.deepEqual(await readdir(realData), ["sentinel"], "the inherited private directory stays untouched");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
