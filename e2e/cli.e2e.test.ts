import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "../skills/machine-session-analytics/scripts/cli.ts");
const server = resolve(here, "../skills/machine-session-analytics/scripts/server.ts");
const manifest = JSON.parse(
  readFileSync(resolve(here, "../skillpack.json"), "utf8"),
) as { version: string };

test("CLI and server expose deterministic help and version contracts", () => {
  const cliHelp = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(cliHelp.status, 0, cliHelp.stderr);
  assert.match(cliHelp.stdout, /all local Codex, Claude, and Cursor session evidence across the machine/);
  assert.match(cliHelp.stdout, /--cursor-database PATH/);
  assert.match(cliHelp.stdout, /--repo-id ID/);

  const cliVersion = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
  assert.equal(cliVersion.status, 0, cliVersion.stderr);
  assert.equal(cliVersion.stdout.trim(), manifest.version);

  const serverHelp = spawnSync(process.execPath, [server, "--help"], { encoding: "utf8" });
  assert.equal(serverHelp.status, 0, serverHelp.stderr);
  assert.match(serverHelp.stdout, /always binds to 127\.0\.0\.1/);
  assert.match(serverHelp.stdout, /this one command performs the complete scan/);

  const serverVersion = spawnSync(process.execPath, [server, "--version"], { encoding: "utf8" });
  assert.equal(serverVersion.status, 0, serverVersion.stderr);
  assert.equal(serverVersion.stdout.trim(), manifest.version);

  const unknown = spawnSync(process.execPath, [cli, "--unknown"], { encoding: "utf8" });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown session analytics argument/);
});
