import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { createSessionAnalyticsFixture } from "./test-support.ts";

const testRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(testRoot, "../../../../..");
const serverPath = join(testRoot, "server.ts");

async function availablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  failure: () => string,
  timeoutMilliseconds = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error(failure());
    await delay(25);
  }
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([
    exited,
    delay(3_000, undefined, { ref: false }).then(() => {
      throw new Error("Session analytics server did not stop after SIGTERM.");
    }),
  ]);
}

async function requestWithHost(port: number, host: string): Promise<number | undefined> {
  return await new Promise((resolve, reject) => {
    const outgoing = request(
      { hostname: "127.0.0.1", port, path: "/api/health", headers: { Host: host } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

test("serves a localhost-only read-only analytics API and dashboard", { timeout: 20_000 }, async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "conductor-session-server-"));
  let child: ChildProcess | null = null;
  try {
    const fixture = await createSessionAnalyticsFixture(temporaryDirectory);
    const port = await availablePort();
    const childEnvironment = {
      ...process.env,
      CONDUCTOR_CLAUDE_PROJECTS_ROOT: fixture.claudeRoot,
      CONDUCTOR_CODEX_ARCHIVED_SESSIONS_ROOT: fixture.codexArchiveRoot,
      CONDUCTOR_CODEX_SESSIONS_ROOT: fixture.codexRoot,
      CONDUCTOR_CURSOR_DATABASE: fixture.cursorDatabasePath,
      CONDUCTOR_ANALYTICS_DATABASE: fixture.databasePath,
    };
    child = spawn(process.execPath, [serverPath, "--port", String(port)], {
      cwd: repositoryRoot,
      env: childEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    await waitFor(
      () => stdout.includes("Machine session analytics ready:"),
      () => `Server did not start. stdout=${stdout} stderr=${stderr}`,
    );

    const origin = `http://127.0.0.1:${port}`;
    const health = await fetch(`${origin}/api/health`);
    assert.equal(health.status, 200);
    const healthBody = (await health.json()) as Record<string, unknown>;
    assert.equal(healthBody.service, "machine-session-analytics");
    assert.equal(healthBody.status, "ok");
    assert.ok(["building", "not-started", "ready"].includes(String(healthBody.snapshot)));
    assert.match(health.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);

    const response = await fetch(`${origin}/api/analytics`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const serialized = await response.text();
    assert.match(serialized, /"analyzedSessions":5/);
    assert.match(serialized, /"providerReportedSpendUsd":1\.48/);
    assert.match(serialized, /"repositories":3/);
    assert.match(serialized, /"skills":\{"frontend-design":1\}/);
    assert.match(serialized, /"skills":\{"review":1\}/);
    assert.match(serialized, /"skillEvidence":"explicit"/);
    assert.match(serialized, /"skillEvidence":"inferred"/);
    assert.doesNotMatch(serialized, /secret-command|secret-path|secret-skill-args|content-is-not-returned/);
    assert.doesNotMatch(serialized, /rollout-|transcriptPath/);

    const refreshed = await fetch(`${origin}/api/analytics?refresh=1`);
    assert.equal(refreshed.status, 200);
    const page = await fetch(origin);
    assert.equal(page.status, 200);
    const pageText = await page.text();
    assert.match(pageText, /SESSION <b>ATLAS<\/b>/);
    assert.match(pageText, /data-view-button="distributions"/);
    assert.match(pageText, /id="activity-tooltip"[\s\S]*role="tooltip"/);
    assert.doesNotMatch(pageText, /PRIVATE OPERATIONS MAP|Machine-wide|Mapping local agent sessions/);
    const application = await fetch(`${origin}/app.js`);
    const applicationText = await application.text();
    assert.match(applicationText, /dataset\.providerFilter/);
    assert.match(applicationText, /renderDistributions/);
    assert.match(applicationText, /renderNamedDistribution/);
    assert.match(applicationText, /activityTooltip[\s\S]*pointerenter/);
    assert.match(applicationText, /Math\.log1p\(value\)[\s\S]*\* 7/);
    assert.match(applicationText, /session-atlas-theme"\) \|\| "light"/);
    const stylesheet = await fetch(`${origin}/styles.css`);
    const stylesheetText = await stylesheet.text();
    assert.match(stylesheetText, /--heat-7:\s*#1f5b49/);
    assert.doesNotMatch(stylesheetText, /--heat-[1-7]:\s*#(?:9a7736|c85b45|c69a5d|d66b55)/);
    assert.equal((await fetch(`${origin}/api/health`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${origin}/missing`)).status, 404);
    assert.equal(await requestWithHost(port, "analytics.example.test"), 403);

    const reused = spawn(process.execPath, [serverPath, "--port", String(port)], {
      cwd: repositoryRoot,
      env: childEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let reusedStdout = "";
    let reusedStderr = "";
    reused.stdout?.setEncoding("utf8");
    reused.stderr?.setEncoding("utf8");
    reused.stdout?.on("data", (chunk: string) => { reusedStdout += chunk; });
    reused.stderr?.on("data", (chunk: string) => { reusedStderr += chunk; });
    const [reuseExitCode] = await once(reused, "exit");
    assert.equal(reuseExitCode, 0, reusedStderr);
    assert.match(reusedStdout, /Machine session analytics already running:/);
  } finally {
    if (child) await stopServer(child);
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});
