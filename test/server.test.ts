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

import { createSessionAnalyticsFixture } from "./fixtures.ts";
import { createInsightsFixture, setUtcBoundaryStarts } from "./insights-fixtures.ts";
import type { InsightsReport } from "../src/types.ts";

const testRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(testRoot, "..");
const serverPath = join(testRoot, "../src/server.ts");

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

test("populated insights HTTP cards preserve privacy and filter UTC instants including offsets", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "insights-http-populated-"));
  let child: ChildProcess | null = null;
  try {
    const fixture = await createInsightsFixture(root);
    await setUtcBoundaryStarts(fixture.source);
    const port = await availablePort();
    child = spawn(process.execPath, [serverPath, "--port", String(port), ...fixture.flags], { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] });
    let ready = false;
    child.stdout?.on("data", (chunk: Buffer) => { ready ||= chunk.toString().includes("Session Analytics ready:"); });
    child.stderr?.resume();
    await waitFor(() => ready, () => "Synthetic insights HTTP server did not start.");
    const origin = `http://127.0.0.1:${port}`;
    const serialized = await (await fetch(`${origin}/api/insights`)).text();
    const full = JSON.parse(serialized) as InsightsReport;
    assert.ok(full.items.length >= 5, "Privacy assertions must exercise populated cards");
    assert.equal(full.schemaVersion, 2); assert.ok(full.groups.length >= 5);
    assert.deepEqual(full.groups.flatMap((group) => group.itemIds).sort(), full.items.map((item) => item.id).sort());
    assert.doesNotMatch(serialized, /secret-|content-is-not-returned|synthetic-private-branch|private\.example|person@example|11111111-1111|rollout-/);
    assert.ok(!serialized.includes(root));
    assert.equal(full.coverage[0]!.totalSessions, 6);
    const filtered = await (await fetch(`${origin}/api/insights?from=2026-09-02&through=2026-09-02`)).json() as InsightsReport;
    assert.ok(filtered.items.length > 0);
    assert.ok(filtered.coverage.every((row) => row.totalSessions === 4));
    assert.match(filtered.warnings.join(" "), /1.*invalid or missing.*start/);
    const next = await (await fetch(`${origin}/api/insights?from=2026-09-03&through=2026-09-03`)).json() as InsightsReport;
    assert.equal(next.coverage[0]!.totalSessions, 1);
  } finally { if (child) await stopServer(child); await rm(root, { recursive: true, force: true }); }
});

test("serves a localhost-only read-only analytics API and dashboard", { timeout: 20_000 }, async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "conductor-session-server-"));
  let child: ChildProcess | null = null;
  try {
    const fixture = await createSessionAnalyticsFixture(temporaryDirectory);
    const port = await availablePort();
    const childEnvironment = {
      ...process.env,
      SESSION_ANALYTICS_CLAUDE_ROOT: fixture.claudeRoot,
      SESSION_ANALYTICS_CODEX_ARCHIVE_ROOT: fixture.codexArchiveRoot,
      SESSION_ANALYTICS_CODEX_ROOT: fixture.codexRoot,
      SESSION_ANALYTICS_CURSOR_DATABASE: fixture.cursorDatabasePath,
      SESSION_ANALYTICS_CONDUCTOR_DATABASE: fixture.databasePath,
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
      () => stdout.includes("Session Analytics ready:"),
      () => `Server did not start. stdout=${stdout} stderr=${stderr}`,
    );

    const origin = `http://127.0.0.1:${port}`;
    const health = await fetch(`${origin}/api/health`);
    assert.equal(health.status, 200);
    const healthBody = (await health.json()) as Record<string, unknown>;
    assert.equal(healthBody.service, "session-analytics");
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

    const insightResponse = await fetch(`${origin}/api/insights`);
    assert.equal(insightResponse.status, 200);
    const insightText = await insightResponse.text();
    const insights = JSON.parse(insightText) as { schemaVersion: number; coverage: Array<{ totalSessions: number }> };
    assert.equal(insights.schemaVersion, 2); assert.equal(insights.coverage.length, 10);
    assert.equal(insights.coverage[0]?.totalSessions, 5);
    assert.doesNotMatch(insightText, /secret-command|secret-path|secret-skill-args|content-is-not-returned|rollout-/);
    assert.equal((await fetch(`${origin}/api/insights?from=2026-02-30`)).status, 400);
    assert.equal((await fetch(`${origin}/api/insights?repo-id=unknown`)).status, 400);
    assert.equal((await fetch(`${origin}/api/insights?send-content=1`)).status, 400);
    assert.equal((await fetch(`${origin}/api/insights`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${origin}/api/review`)).status, 404);
    const emptyInsights = await (await fetch(`${origin}/api/insights?from=2099-01-01`)).json() as { items: unknown[]; coverage: Array<{ totalSessions: number }> };
    assert.equal(emptyInsights.items.length, 0); assert.equal(emptyInsights.coverage[0]?.totalSessions, 0);
    for (const path of ["/views/insights.js", "/views/insights-state.js", "/views/insights.css"]) assert.equal((await fetch(`${origin}${path}`)).status, 200);

    const refreshed = await fetch(`${origin}/api/analytics?refresh=1`);
    assert.equal(refreshed.status, 200);
    const page = await fetch(origin);
    assert.equal(page.status, 200);
    const pageText = await page.text();
    assert.match(pageText, /SESSION <b>ANALYTICS<\/b>/);
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
    assert.match(applicationText, /session-analytics-theme"\) \|\| "light"/);
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
    assert.match(reusedStdout, /Session Analytics already running:/);
  } finally {
    if (child) await stopServer(child);
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});
