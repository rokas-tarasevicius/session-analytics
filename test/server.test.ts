import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { createSessionAnalyticsFixture } from "./fixtures.ts";
import { addUnsafeVelocityModels } from "./velocity-fixtures.ts";

import { plantMalformedModels } from "./model-privacy-fixture.ts";
import { createOutcomeFixture, outcomeSentinels } from "./outcomes-fixtures.ts";
import { addCommandHistoryFixture, commandSentinels } from "./workflow-fixtures.ts";

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

test("serves a localhost-only read-only analytics API and dashboard", { timeout: 20_000 }, async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "conductor-session-server-"));
  let child: ChildProcess | null = null;
  try {
    const fixture = await createOutcomeFixture(temporaryDirectory);
    const secret = "/private/API-STRUCTURED-SECRET command --token=credential";
    const path = join(fixture.claudeRoot, "-fixtures-workspaces-conductor-claude-workspace", "22222222-2222-4222-8222-222222222222.jsonl");
    await appendFile(path, JSON.stringify({ type: "assistant", timestamp: secret, effort: secret, message: { id: "bad-metadata", model: secret, usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "tool_use", id: "bad-tool", name: secret }] } }) + "\n");
    const db = new DatabaseSync(fixture.databasePath);
    db.prepare("UPDATE sessions SET status=?,created_at=? WHERE agent_type='claude'").run(secret, secret); db.close();

    const unsafeModelSessions = await addUnsafeVelocityModels(fixture);

    await plantMalformedModels(fixture);
    await appendFile(join(fixture.codexRoot, "2026/07/20", "rollout-2026-07-20T10-00-00-11111111-1111-4111-8111-111111111111.jsonl"),
      JSON.stringify({ type: "event_msg", timestamp: "2026-07-20T10:10:00Z", payload: { type: "token_count", info: null,
        rate_limits: { limit_id: "secret-limit-payload", plan_type: "secret-limit-payload", primary: { used_percent: 80, window_minutes: 300, resets_at: 1784548800, payload: "secret-limit-payload" }, credits: { balance: "secret-limit-payload" } } } }) + "\n");
    await addCommandHistoryFixture(fixture);
    const port = await availablePort();
    const childEnvironment = {
      ...process.env,
      SESSION_ANALYTICS_NO_INDEX: "1", SESSION_ANALYTICS_ADDITIONAL_PROVIDERS: "0",

      SESSION_ANALYTICS_OFFLINE: "1",
      SESSION_ANALYTICS_DATA_DIR: join(temporaryDirectory, "pricing-data"),
      SESSION_ANALYTICS_CLAUDE_ROOT: fixture.claudeRoot,
      SESSION_ANALYTICS_CODEX_ARCHIVE_ROOT: fixture.codexArchiveRoot,
      SESSION_ANALYTICS_CODEX_ROOT: fixture.codexRoot,
      SESSION_ANALYTICS_CURSOR_DATABASE: fixture.cursorDatabasePath,
      SESSION_ANALYTICS_CONDUCTOR_DATABASE: fixture.databasePath,
      SESSION_ANALYTICS_RELIABILITY_CONTENT_RULES: "1",

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
    assert.equal(JSON.parse(serialized).summary.analyzedSessions, 5 + unsafeModelSessions);
    assert.doesNotMatch(serialized, commandSentinels);
    assert.match(serialized, /\/custom.audit/);
    assert.match(serialized, /"providerReportedSpendUsd":1\.48/);
    assert.match(serialized, /"repositories":3/);
    assert.match(serialized, /"skills":\{"frontend-design":1\}/);
    assert.match(serialized, /"skills":\{"review":1\}/);
    assert.match(serialized, /"skillEvidence":"explicit"/);
    assert.match(serialized, /"skillEvidence":"inferred"/);
    assert.match(serialized, /"reliability":\{"version":1,"contentRules":"enabled"/);
    assert.doesNotMatch(serialized, /argHash|fileHash|reliability-hmac/);
    assert.match(serialized, /"workflow":\{"schemaVersion":1/);
    assert.doesNotMatch(serialized, /secret-command|secret-path|secret-skill-args|content-is-not-returned/);
    assert.doesNotMatch(serialized, /rollout-|transcriptPath|API-STRUCTURED-SECRET/);

    assert.doesNotMatch(serialized, /velocity-model-SENTINEL/);
    assert.doesNotMatch(serialized, /rollout-|transcriptPath/);
    assert.doesNotMatch(serialized, /secret-limit-payload/);
    assert.doesNotMatch(serialized, /SYNTHETIC-MODEL-SENTINEL/);
    assert.match(serialized, /"usedPercent":80/);
    assert.equal(JSON.parse(serialized).outcomes.pullRequests.merged, 1);
    for (const sentinel of outcomeSentinels) assert.ok(!serialized.includes(sentinel));

    for (const path of ["/api/insights", "/api/review", "/workflow.js", "/workflow-scope.js", "/workflow-worker.js", "/workflow.css", "/views/insights.js", "/views/insights-state.js", "/views/insights.css", "/views/limits-cache.js", "/views/limits-cache.css", "/outcomes.js", "/outcomes-summary.js", "/outcomes.css", "/reliability-data.js", "/reliability-view.js", "/reliability.css"]) {
      assert.equal((await fetch(`${origin}${path}`)).status, 404, path);
    }

    const refreshed = await fetch(`${origin}/api/analytics?refresh=1`);
    assert.equal(refreshed.status, 200);
    const page = await fetch(origin);
    assert.equal(page.status, 200);
    const pageText = await page.text();
    assert.match(pageText, /class="wordmark-text">Session <b>Analytics<\/b>/);
    assert.match(pageText, /<svg class="logo"[\s\S]*fill="#d66b55"[\s\S]*fill="#7eb7a7"[\s\S]*fill="#d4aa70"/);
    assert.match(pageText, /data-view-button="pricing"/);
    assert.match(pageText, /id="pricing-panel"/);

    assert.match(pageText, /data-view-button="velocity"/);
    assert.match(pageText, /id="velocity-view"/);
    assert.match(serialized, /"velocity":\{"version":1,"timeZone":/);
    for (const resource of ["velocity.js", "velocity-data.js", "velocity.css"]) {
      const asset = await fetch(`${origin}/${resource}`);
      assert.equal(asset.status, 200);
      assert.match(asset.headers.get("content-type") ?? "", resource.endsWith(".css") ? /text\/css/ : /text\/javascript/);
      assert.match(asset.headers.get("content-security-policy") ?? "", /script-src 'self'/);
      assert.equal((await fetch(`${origin}/${resource}`, { method: "POST" })).status, 405);
    }

    for (const asset of ["workflow-data.js", "metrics/outcomes-summary.js"]) {
      const response = await fetch(`${origin}/${asset}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    }
    assert.match(pageText, /id="activity-tooltip"[\s\S]*role="tooltip"/);
    assert.match(pageText, /<dialog class="palette" id="command-palette"[\s\S]*role="combobox"[\s\S]*role="listbox"/);
    assert.match(pageText, /<dialog class="help" id="help-overlay"/);
    assert.match(pageText, /data-window-preset="30" aria-pressed="true"/);
    assert.match(pageText, /data-provider-filter="claude"/);
    assert.match(pageText, /<th scope="col"[^>]*><button type="button" class="sort" data-sort="value"/);
    assert.doesNotMatch(pageText, /https?:\/\/(?!127\.0\.0\.1)/);
    assert.doesNotMatch(pageText, /PRIVATE OPERATIONS MAP|Machine-wide|Mapping local agent sessions/);
    const application = await fetch(`${origin}/app.js`);
    const applicationText = await application.text();
    assert.match(applicationText, /dataset\.providerFilter/);
    const providerModule = await fetch(`${origin}/providers.js`);
    assert.equal(providerModule.status, 200);
    assert.match(providerModule.headers.get("content-type") ?? "", /javascript/);
    assert.match(await providerModule.text(), /renderProviderEvidence/);
    for (const provider of ["copilot", "opencode", "gemini"]) assert.ok(pageText.includes(`data-provider-filter="${provider}"`));
    assert.match(pageText, /id="provider-evidence-rows"/);

    const pricing = await fetch(`${origin}/pricing.js`);
    assert.equal(pricing.status, 200);
    assert.match(await pricing.text(), /renderPricingPanel/);
    assert.equal((await fetch(`${origin}/pricing.css`)).status, 200);
    assert.equal((await fetch(`${origin}/model-id.js`)).status, 200);
    assert.match(applicationText, /renderTools/);
    assert.match(applicationText, /activityTooltip[\s\S]*pointerenter/);
    assert.match(applicationText, /from "\.\/view-model\.js"/);
    const viewModel = await fetch(`${origin}/view-model.js`);
    assert.equal(viewModel.status, 200);
    assert.equal(viewModel.headers.get("content-type"), "text/javascript; charset=utf-8");
    const viewModelText = await viewModel.text();
    assert.match(viewModelText, /Math\.log1p\(value\)[\s\S]*\* 7/);
    assert.match(viewModelText, /export function clampWindow/);
    assert.match(applicationText, /readPreference\("session-analytics-theme"\) \|\| systemTheme/);
    assert.match(applicationText, /prefers-color-scheme: dark/);
    assert.match(applicationText, /session-analytics-view/);
    assert.match(applicationText, /showModal\(\)/);
    assert.match(applicationText, /aria-activedescendant/);
    assert.match(applicationText, /attachCrosshair/);
    assert.match(applicationText, /viewProviderFilters = \{[\s\S]*activity: new Set/);
    assert.match(applicationText, /session-analytics-shortcuts/);
    assert.match(pageText, /id="activity-provider-filters"[\s\S]*id="tools-provider-filters"/);
    assert.match(pageText, /id="shortcuts-toggle"/);
    assert.match(pageText, /data-view-button="costs" data-label="Costs"/);
    const stylesheet = await fetch(`${origin}/styles.css`);
    const stylesheetText = await stylesheet.text();
    assert.match(stylesheetText, /--heat-7:\s*#005742/);
    assert.match(stylesheetText, /:root\[data-theme="dark"\][\s\S]*--heat-7:\s*#7eddc0/);
    assert.doesNotMatch(stylesheetText, /--heat-[1-7]:\s*#(?:9a7736|c85b45|c69a5d|d66b55)/);
    assert.match(stylesheetText, /--coral: #d66b55;[\s\S]*--sage: #7eb7a7;[\s\S]*--ochre: #d4aa70;/);
    assert.match(stylesheetText, /prefers-reduced-motion: reduce/);
    assert.match(stylesheetText, /url\("\/fonts\/geist-latin\.woff2"\)/);
    assert.doesNotMatch(stylesheetText, /url\((?!"\/)/);
    const font = await fetch(`${origin}/fonts/geist-latin.woff2`);
    assert.equal(font.status, 200);
    assert.equal(font.headers.get("content-type"), "font/woff2");
    assert.equal((await fetch(`${origin}/fonts/space-grotesk-latin.woff2`)).status, 404);
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
