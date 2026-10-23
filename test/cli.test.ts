import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { analysisBooleanFlags, analysisValueFlags } from "../src/options.ts";

const here = dirname(fileURLToPath(import.meta.url));
const bin = resolve(here, "../bin/session-analytics.ts");
const cli = resolve(here, "../src/cli.ts");
const server = resolve(here, "../src/server.ts");
const manifest = JSON.parse(readFileSync(resolve(here, "../package.json"), "utf8")) as {
  bin: Record<string, string>;
  version: string;
};

function run(path: string, args: string[]) {
  return spawnSync(process.execPath, [path, ...args], { encoding: "utf8" });
}

test("the command dispatcher exposes help, version, and both subcommands", () => {
  assert.equal(manifest.bin["session-analytics"], "bin/session-analytics.ts");

  const help = run(bin, ["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /session-analytics \[dashboard\] \[options\]/);
  assert.match(help.stdout, /session-analytics report \[options\]/);

  const version = run(bin, ["--version"]);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), manifest.version);

  const reportHelp = run(bin, ["report", "--help"]);
  assert.equal(reportHelp.status, 0, reportHelp.stderr);
  assert.match(reportHelp.stdout, /all local Codex, Claude, and Cursor session evidence across the machine/);
  assert.match(reportHelp.stdout, /--cursor-database PATH/);

  const dashboardHelp = run(bin, ["dashboard", "--help"]);
  assert.equal(dashboardHelp.status, 0, dashboardHelp.stderr);
  assert.match(dashboardHelp.stdout, /always binds to 127\.0\.0\.1/);
  // Every analysis option the dashboard accepts is in its help, as for report and mcp.
  for (const flag of [...analysisValueFlags, ...analysisBooleanFlags, "--snapshot", "--exclude-hidden", "--no-codex-account"]) assert.match(dashboardHelp.stdout, new RegExp(`^  ${flag} `, "m"), flag);
});

test("report and dashboard entrypoints keep deterministic contracts", () => {
  const cliHelp = run(cli, ["--help"]);
  assert.equal(cliHelp.status, 0, cliHelp.stderr);
  assert.match(cliHelp.stdout, /--repo-id ID/);

  const cliVersion = run(cli, ["--version"]);
  assert.equal(cliVersion.status, 0, cliVersion.stderr);
  assert.equal(cliVersion.stdout.trim(), manifest.version);

  const serverHelp = run(server, ["--help"]);
  assert.equal(serverHelp.status, 0, serverHelp.stderr);
  assert.match(serverHelp.stdout, /this one command performs the complete scan/);

  const serverVersion = run(server, ["--version"]);
  assert.equal(serverVersion.status, 0, serverVersion.stderr);
  assert.equal(serverVersion.stdout.trim(), manifest.version);

  const unknown = run(bin, ["report", "--unknown"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown session analytics argument/);
});

test("report rejects malformed arguments before analysis, with diagnostics only on stderr", () => {
  for (const args of [
    ["--unknown"], ["unexpected"], ["--repo-name"], ["--repo-name", "--json"],
    ["--repo-name", "one", "--repo-name", "two"], ["--time-zone", "invalid"],
    ["--no-remote", "--remote", "example"],
  ]) {
    const result = run(bin, ["report", ...args]);
    assert.equal(result.status, 2, args.join(" "));
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.trim().length > 0);
    assert.doesNotMatch(result.stderr, /\bat file:|Error:|unexpected|--unknown|\bone\b|\btwo\b/);
  }
});

test("terminal reports fit piped widths without color and JSON stays a complete snapshot", async () => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { createSessionAnalyticsFixture } = await import("./fixtures.ts");
  const { analyzeMachineSessions } = await import("../src/analyzer.ts");
  const { textWidth } = await import("../src/report/format.ts");
  const directory = await mkdtemp(resolve(tmpdir(), "session-analytics-report-format-"));
  try {
    const snapshot = await analyzeMachineSessions({ ...await createSessionAnalyticsFixture(directory), offline: true });
    const fix = "run session-analytics machines check server-with-a-long-but-valid-name";
    snapshot.machines = [
      { key: "local", label: "laptop", state: "ok", sessions: snapshot.summary.sessions,
        repositories: snapshot.summary.repositories, readAt: snapshot.generatedAt, durationMs: 12, version: manifest.version },
      { key: "server", label: "build-server", state: "failed", reason: "connection", fix,
        sessions: 0, repositories: 0, readAt: null, durationMs: null, version: null },
    ];
    const path = resolve(directory, "snapshot.json");
    await writeFile(path, JSON.stringify(snapshot));
    for (const columns of ["20", "80", "120", "invalid"]) {
      for (const color of [{ NO_COLOR: "1", FORCE_COLOR: undefined }, { NO_COLOR: undefined, FORCE_COLOR: "1" }]) {
        const result = spawnSync(process.execPath, [bin, "report", "--snapshot", path], {
          encoding: "utf8", env: { ...process.env, ...color, COLUMNS: columns },
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, "");
        assert.doesNotMatch(result.stdout, /\u001b\[/);
        assert.ok(result.stdout.split("\n").every((line) => textWidth(line) <= (Number(columns) || 80)));
        assert.match(result.stdout, /Repository\s+comparison/);
        assert.match(result.stdout, /Machines:/);
        assert.ok(result.stdout.replace(/\s/gu, "").includes(fix.replace(/\s/gu, "")), "wrapped machine fix stays complete");
        if (columns !== "20") assert.match(result.stdout, /not an invoice/);
      }
    }
    for (const columns of ["20", "80", "120"]) {
      const json = spawnSync(process.execPath, [bin, "report", "--json", "--snapshot", path], {
        encoding: "utf8", env: { ...process.env, COLUMNS: columns },
      });
      assert.equal(json.status, 0, json.stderr);
      assert.equal(json.stderr, "");
      assert.deepEqual(JSON.parse(json.stdout), snapshot);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("report reads SESSION_ANALYTICS_* settings and returns only fixture evidence", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { createSessionAnalyticsFixture } = await import("./fixtures.ts");
  const directory = await mkdtemp(resolve(tmpdir(), "session-analytics-env-"));
  try {
    const fixture = await createSessionAnalyticsFixture(directory);
    const result = spawnSync(process.execPath, [bin, "report", "--json"], {
      encoding: "utf8",
      env: {
        ...process.env,
        SESSION_ANALYTICS_NO_INDEX: "1", SESSION_ANALYTICS_ADDITIONAL_PROVIDERS: "0",

        SESSION_ANALYTICS_OFFLINE: "1",
        SESSION_ANALYTICS_DATA_DIR: resolve(directory, "pricing-data"),
        SESSION_ANALYTICS_CLAUDE_ROOT: fixture.claudeRoot,
        SESSION_ANALYTICS_CODEX_ARCHIVE_ROOT: fixture.codexArchiveRoot,
        SESSION_ANALYTICS_CODEX_ROOT: fixture.codexRoot,
        SESSION_ANALYTICS_CONDUCTOR_DATABASE: fixture.databasePath,
        SESSION_ANALYTICS_CURSOR_DATABASE: fixture.cursorDatabasePath,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const snapshot = JSON.parse(result.stdout) as { summary: { repositories: number; sessions: number } };
    assert.equal(snapshot.summary.sessions, 5);
    assert.equal(snapshot.summary.repositories, 3);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("demo sweeps stale temp roots", async () => {
  const { lstat, mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const directory = await mkdtemp(resolve(tmpdir(), "session-analytics-demo-sweep-test-"));
  try {
    const stale = resolve(directory, "session-analytics-demo-x");
    const fresh = resolve(directory, "session-analytics-demo-fresh");
    const kept = resolve(directory, "session-analytics-demo-kept");
    const owned = resolve(directory, "session-analytics-demo-owned");
    const abandoned = resolve(directory, "session-analytics-demo-abandoned");
    const unrelated = resolve(directory, "unrelated-directory");
    const file = resolve(directory, "session-analytics-demo-file");
    const link = resolve(directory, "session-analytics-demo-link");
    for (const root of [stale, fresh, kept, owned, abandoned, unrelated]) await mkdir(root);
    await writeFile(resolve(stale, "synthetic-data"), "fixture");
    await writeFile(resolve(kept, ".keep"), "");
    // A live owner (this test process) protects its root; a dead owner does not.
    await writeFile(resolve(owned, ".demo-owner"), `${process.pid}\n`);
    await writeFile(resolve(abandoned, ".demo-owner"), `${spawnSync(process.execPath, ["-e", "0"]).pid}\n`);
    await writeFile(file, "fixture");
    await symlink(unrelated, link, "dir");
    const old = new Date(Date.now() - 2 * 86_400_000);
    for (const path of [stale, kept, owned, abandoned, unrelated, file]) await utimes(path, old, old);
    const result = spawnSync(process.execPath, [resolve(here, "../scripts/demo.ts"), "report", "--json"], {
      encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 180_000,
      env: { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(JSON.parse(result.stdout).sessions.length > 0);
    assert.deepEqual((await readdir(directory)).sort(), ["session-analytics-demo-file", "session-analytics-demo-fresh", "session-analytics-demo-kept", "session-analytics-demo-link", "session-analytics-demo-owned", "unrelated-directory"]);
    assert.equal((await lstat(link)).isSymbolicLink(), true);
  } finally { await rm(directory, { force: true, recursive: true }); }
});
