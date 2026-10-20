import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { formula, installation, newer, runUpgrade, upgradeCommand, type UpgradeDependencies } from "../src/upgrade.ts";
import { version } from "../src/version.ts";

const here = dirname(fileURLToPath(import.meta.url));

test("an installation is told apart by where its package lives", () => {
  assert.deepEqual(installation("/opt/homebrew/Cellar/session-analytics/0.10.2/libexec/lib/node_modules/session-analytics"), { kind: "homebrew" });
  assert.deepEqual(installation("/home/linuxbrew/.linuxbrew/Cellar/session-analytics/0.10.2/libexec/lib/node_modules/session-analytics"), { kind: "homebrew" });
  assert.deepEqual(installation("/home/me/.nvm/versions/node/v24.1.0/lib/node_modules/session-analytics"), { kind: "npm", prefix: "/home/me/.nvm/versions/node/v24.1.0", global: true });
  assert.deepEqual(installation("/home/me/project/node_modules/session-analytics"), { kind: "npm", prefix: "/home/me/project", global: false });
  assert.deepEqual(installation("/home/me/src/session-analytics"), { kind: "checkout", root: "/home/me/src/session-analytics" });

  assert.deepEqual(upgradeCommand({ kind: "homebrew" }), ["brew", "upgrade", formula]);
  assert.deepEqual(upgradeCommand({ kind: "npm", prefix: "/usr/local", global: true }), ["npm", "install", "--global", "--prefix", "/usr/local", "session-analytics@latest"]);
  assert.deepEqual(upgradeCommand({ kind: "npm", prefix: "/p", global: false }), ["npm", "install", "--prefix", "/p", "session-analytics@latest"]);
  assert.equal(upgradeCommand({ kind: "checkout", root: "/r" }), null);
});

test("only a later stable release counts as newer", () => {
  assert.equal(newer("0.10.3", "0.10.2"), true);
  assert.equal(newer("0.11.0", "0.10.9"), true);
  assert.equal(newer("1.0.0", "0.99.99"), true);
  assert.equal(newer("0.10.2", "0.10.2"), false);
  assert.equal(newer("0.9.9", "0.10.0"), false);
  assert.equal(newer("0.11.0-beta.1", "0.10.2"), false);
});

function harness(packageRoot: string, latest: string | Error, status = 0) {
  const ran: string[][] = [], out: string[] = [], err: string[] = [];
  const dependencies: Partial<UpgradeDependencies> = {
    packageRoot, run: (command) => { ran.push(command); return status; },
    latest: async () => { if (latest instanceof Error) throw latest; return latest; },
    out: (line) => out.push(line), err: (line) => err.push(line),
  };
  return { ran, out, err, dependencies };
}
const brew = "/opt/homebrew/Cellar/session-analytics/0.10.2/libexec/lib/node_modules/session-analytics";
const npm = "/usr/local/lib/node_modules/session-analytics";

test("upgrade runs the installing package manager only when a newer release exists", async () => {
  let h = harness(brew, "99.0.0");
  assert.equal(await runUpgrade([], h.dependencies), 0);
  assert.deepEqual(h.ran, [["brew", "upgrade", formula]]);
  assert.match(h.out.join("\n"), /to 99\.0\.0/);

  h = harness(npm, "99.0.0");
  assert.equal(await runUpgrade([], h.dependencies), 0);
  assert.deepEqual(h.ran, [["npm", "install", "--global", "--prefix", "/usr/local", "session-analytics@latest"]]);

  h = harness(npm, version);
  assert.equal(await runUpgrade([], h.dependencies), 0);
  assert.deepEqual(h.ran, []);
  assert.match(h.out.join("\n"), /is the latest release/);

  // An unreachable registry leaves the decision to the package manager.
  h = harness(brew, new Error("offline"));
  assert.equal(await runUpgrade([], h.dependencies), 0);
  assert.equal(h.ran.length, 1);

  h = harness(npm, "99.0.0", 243);
  assert.equal(await runUpgrade([], h.dependencies), 243);
  assert.match(h.err.join("\n"), /npm exited with 243; Session Analytics was not upgraded/);
});

test("upgrade --check changes nothing, and a checkout is never upgraded", async () => {
  let h = harness(npm, "99.0.0");
  assert.equal(await runUpgrade(["--check"], h.dependencies), 0);
  assert.deepEqual(h.ran, []);
  assert.match(h.out.join("\n"), /99\.0\.0 is available; .* is installed \(npm\)/);

  h = harness(brew, new Error("offline"));
  assert.equal(await runUpgrade(["--check"], h.dependencies), 1);

  h = harness("/home/me/src/session-analytics", "99.0.0");
  assert.equal(await runUpgrade([], h.dependencies), 1);
  assert.deepEqual(h.ran, []);
  assert.match(h.err.join("\n"), /source checkout .*git pull/);

  h = harness(npm, "99.0.0");
  assert.equal(await runUpgrade(["--force"], h.dependencies), 2);
});

test("the dispatcher serves upgrade help and refuses to upgrade this checkout", () => {
  const bin = resolve(here, "../bin/session-analytics.ts");
  const help = spawnSync(process.execPath, [bin, "upgrade", "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /upgrade --check/);
  assert.match(spawnSync(process.execPath, [bin, "--help"], { encoding: "utf8" }).stdout, /upgrade \[--check\]/);
  const checkout = spawnSync(process.execPath, [bin, "upgrade"], { encoding: "utf8" });
  assert.equal(checkout.status, 1);
  assert.match(checkout.stderr, /source checkout/);
});
