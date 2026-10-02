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
