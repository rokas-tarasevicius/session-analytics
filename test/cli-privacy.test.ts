import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const bin = fileURLToPath(new URL("../bin/session-analytics.ts", import.meta.url));
const secret = "/private/CLI-ARGUMENT-SENTINEL";
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:SESSION_ANALYTICS_|CONDUCTOR_)/.test(key)));

// Regression: arbitrary argv and environment values must never be printed in diagnostics.
test("report and dashboard reject unknown arguments without echoing private input", () => {
  for (const command of ["report", "dashboard"]) {
    for (const value of [secret, `--data-dir=${secret}`, `--${secret}`]) {
      const result = spawnSync(process.execPath, [bin, command, value], { encoding: "utf8", env: environment, timeout: 10_000 });
      assert.equal(result.status, 2, result.stderr);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /Unknown session analytics/);
      assert.doesNotMatch(result.stderr, /CLI-ARGUMENT-SENTINEL|\/private\//);
    }
  }
});

test("invalid dashboard ports exit 2 with one fixed diagnostic", () => {
  const cases = [
    ...[secret, "NaN", "0", "1023", "65536", "4174.5"].map((value) => ({ args: ["--port", value], env: environment })),
    { args: [], env: { ...environment, SESSION_ANALYTICS_PORT: secret } },
    { args: [], env: { ...environment, CONDUCTOR_PORT: secret } },
  ];
  for (const { args, env } of cases) {
    const result = spawnSync(process.execPath, [bin, "dashboard", "--no-open", "--no-remote", ...args], { encoding: "utf8", env, timeout: 10_000 });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Session analytics port must be an integer from 1024 through 65535.\n");
  }
});

test("report and dashboard reject missing and duplicate values before scanning", () => {
  for (const command of ["report", "dashboard"]) {
    for (const args of [["--data-dir"], ["--data-dir", "--offline"], ["--data-dir", secret, "--data-dir", secret]]) {
      const result = spawnSync(process.execPath, [bin, command, ...args], { encoding: "utf8", env: environment, timeout: 10_000 });
      assert.equal(result.status, 2, result.stderr);
      assert.equal(result.stdout, "");
      assert.doesNotMatch(result.stderr, /CLI-ARGUMENT-SENTINEL/);
      assert.match(result.stderr, /requires a value|Give --data-dir once/);
    }
  }
  const unknown = spawnSync(process.execPath, [bin, secret], { encoding: "utf8", env: environment, timeout: 10_000 });
  assert.equal(unknown.status, 2);
  assert.equal(unknown.stdout, "");
  assert.equal(unknown.stderr, "Unknown command. Run session-analytics --help.\n");
});
