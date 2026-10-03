import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
