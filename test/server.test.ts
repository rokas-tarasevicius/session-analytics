import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, chmod, link, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, request } from "node:http";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createSessionAnalyticsFixture } from "./fixtures.ts";
import { addUnsafeVelocityModels } from "./velocity-fixtures.ts";

import { plantMalformedModels } from "./model-privacy-fixture.ts";
import { readDashboardToken, writeDashboardToken } from "../src/store/dashboard.ts";
import { reuseRefusal } from "../src/dashboard-reuse.ts";
import { version } from "../src/version.ts";
import { staticRoutes } from "../src/static-routes.ts";

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

async function requestWithHost(port: number, host: string, headers: Record<string, string> = {}, path = "/api/health"): Promise<number | undefined> {
  return await new Promise((resolve, reject) => {
    const outgoing = request(
      { hostname: "127.0.0.1", port, path, headers: { Host: host, ...headers } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

test("serves a localhost-only read-only analytics API and dashboard", { timeout: 30_000 }, async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "conductor-session-server-"));
  let child: ChildProcess | null = null;
  try {
    const fixture = await createSessionAnalyticsFixture(temporaryDirectory);
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
    const port = await availablePort();
    const rejectionModule = join(temporaryDirectory, "rejection.mjs");
    await writeFile(rejectionModule, `import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
childProcess.execFile = (...args) => args.at(-1)(new Error("PRIVATE-BROWSER-SENTINEL"));
syncBuiltinESMExports();
setTimeout(() => { void Promise.reject(new Error("PRIVATE-REJECTION-SENTINEL")); }, 1000);
`);
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
      // A retired opt-in must not change the output or re-enable content rules.
      SESSION_ANALYTICS_RELIABILITY_CONTENT_RULES: "1",

    };
    child = spawn(process.execPath, ["--import", pathToFileURL(rejectionModule).href, serverPath, "--port", String(port), "--open"], {
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
    await t.test("health exposes only content-free launch identity and stores a private per-port token", async () => {
      assert.deepEqual(Object.keys(healthBody).sort(), ["dataSource", "instanceToken", "optionsHash", "scanHash", "service", "snapshot", "status", "version"]);
      assert.equal(healthBody.version, version);
      assert.match(String(healthBody.instanceToken), /^[a-f0-9]{64}$/);
      assert.match(String(healthBody.optionsHash), /^[a-f0-9]{64}$/);
      assert.match(String(healthBody.scanHash), /^[a-f0-9]{64}$/);
      const tokenFile = join(childEnvironment.SESSION_ANALYTICS_DATA_DIR, `dashboard-${port}.token`);
      assert.equal(await readFile(tokenFile, "utf8"), healthBody.instanceToken);
      assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
      assert.equal((await stat(childEnvironment.SESSION_ANALYTICS_DATA_DIR)).mode & 0o777, 0o700);
      assert.doesNotMatch(JSON.stringify(healthBody), /API-STRUCTURED-SECRET|secret|conductor-session-server|pricing-data|claudeRoot|includeHidden/);
    });
    await t.test("a malformed request target gets 400 and the server survives", async () => {
      const rawRequest = async (host: string): Promise<string> => new Promise((resolve, reject) => {
        const socket = connect(port, "127.0.0.1", () => {
          socket.write(`GET http://a:b:c/ HTTP/1.1\r\nHost: ${host}\r\n\r\n`);
        });
        let raw = "";
        socket.setEncoding("utf8");
        socket.setTimeout(3_000, () => socket.destroy(new Error("Raw request timed out.")));
        socket.on("data", (chunk) => {
          raw += chunk;
          if (/\{"error":"[^"\n]*"\}\n/.test(raw)) { socket.destroy(); resolve(raw); }
        });
        socket.on("error", reject);
      });
      const response = await rawRequest(`127.0.0.1:${port}`);
      assert.match(response, /^HTTP\/1\.1 400 /);
      assert.match(response, /Content-Security-Policy: default-src 'self'/i);
      assert.match(response, /X-Content-Type-Options: nosniff/i);
      assert.match(response, /\{"error":"Bad request\."\}\n/);
      assert.match(await rawRequest("evil.example"), /^HTTP\/1\.1 403 /, "loopback check runs first");
      assert.equal((await fetch(`${origin}/api/health`)).status, 200);
    });
    await t.test("an unhandled rejection logs a fixed line and the server survives", async () => {
      const line = "Session analytics encountered an unexpected asynchronous failure; the server is still running.";
      await waitFor(() => stderr.includes(line), () => "The rejection backstop did not log.");
      assert.equal(stderr.split(line).length - 1, 1);
      assert.doesNotMatch(stderr, /PRIVATE-REJECTION-SENTINEL|rejection\.mjs|Error:/);
      assert.equal((await fetch(`${origin}/api/health`)).status, 200);
    });

    for (const [name, headers] of [
      ["external Origin", { Origin: "https://evil.example" }],
      ["null Origin", { Origin: "null" }],
      ["another loopback port", { Origin: "http://localhost:3000" }],
      ["same loopback hostname on another port", { Origin: "http://127.0.0.1:3000" }],
      ["cross-site fetch", { "Sec-Fetch-Site": "cross-site" }],
      ["same-site fetch", { "Sec-Fetch-Site": "same-site" }],
      ["same-origin fetch with a mismatched Origin", { "Sec-Fetch-Site": "same-origin", Origin: "http://localhost:3000" }],
    ] as Array<[string, Record<string, string>]>) {
      await t.test(`API rejects ${name}`, async () => {
        for (const path of ["/api/analytics", "/api/analytics?refresh=1", "/api/health"]) {
          assert.equal(await requestWithHost(port, `127.0.0.1:${port}`, headers, path), 403, path);
        }
      });
    }
    await t.test("API accepts same-origin and header-less loopback requests while static files remain reachable", async () => {
      for (const headers of [{}, { Origin: origin }, { "Sec-Fetch-Site": "same-origin", Origin: origin }, { "Sec-Fetch-Site": "none" }] as Array<Record<string, string>>) {
        assert.equal(await requestWithHost(port, `127.0.0.1:${port}`, headers, "/api/analytics"), 200);
      }
      assert.equal(await requestWithHost(port, `localhost:${port}`, { Origin: `http://localhost:${port}` }, "/api/analytics"), 200);
      assert.equal(await requestWithHost(port, `127.0.0.1:${port}`, { Origin: "http://localhost:3000", "Sec-Fetch-Site": "cross-site" }, "/app.js"), 200);
    });

    await t.test("shared formatters are served as a same-origin dashboard module", async () => {
      const module = await fetch(`${origin}/format.js`);
      assert.equal(module.status, 200);
      assert.match(module.headers.get("content-type")!, /javascript/);
      assert.match(module.headers.get("content-security-policy")!, /script-src 'self'/);
      assert.match(await module.text(), /export function moneyAxis/);
      assert.equal((await fetch(`${origin}/format.d.ts`)).status, 404);
    });

    await t.test("every static route supports query strings with explicit types and security headers", async () => {
      const types: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", svg: "image/svg+xml; charset=utf-8", woff2: "font/woff2" };
      for (const [route, file] of staticRoutes) {
        const response = await fetch(`${origin}${route}?v=fixture`);
        assert.equal(response.status, 200, route);
        assert.equal(response.headers.get("content-type"), types[file.split(".").at(-1)!], route);
        assert.equal(response.headers.get("x-content-type-options"), "nosniff", route);
        assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/, route);
        assert.equal(response.headers.get("access-control-allow-origin"), null, route);
        await response.arrayBuffer();
      }
    });

    await t.test("method and path rejections retain security headers", async () => {
      for (const [path, method, status] of [["/api/health", "HEAD", 405], ["/api/analytics", "OPTIONS", 405], ["/missing", "GET", 404], ["/../server.ts", "GET", 404], ["/%2e%2e/server.ts", "GET", 404], ["/%2fapp.js", "GET", 404], ["/api/health", "GET", 403]] as const) {
        const response = await fetch(`${origin}${path}`, { method, ...(status === 403 ? { headers: { Origin: "null" } } : {}) });
        assert.equal(response.status, status, `${method} ${path}`);
        assert.equal(response.headers.get("x-content-type-options"), "nosniff");
        assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
        assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
        const body = await response.text();
        if (method === "HEAD") assert.equal(body, "");
        else assert.deepEqual(Object.keys(JSON.parse(body)), ["error"]);
      }
      assert.equal(await requestWithHost(port, "[::1]"), 403, "the server binds IPv4 loopback only");
      assert.deepEqual(await (await fetch(`${origin}/api/machines`)).json(), { machines: [] });
    });

    const response = await fetch(`${origin}/api/analytics`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const serialized = await response.text();
    assert.equal(JSON.parse(serialized).summary.analyzedSessions, 5 + unsafeModelSessions);
    assert.match(serialized, /"providerReportedSpendUsd":1\.48/);
    assert.match(serialized, /"repositories":3/);
    for (const removed of ["skills", "skillEvidence", "reliability", "limitsCache", "outcomes", "workflow", "insightSignals"]) assert.doesNotMatch(serialized, new RegExp(`"${removed}":`), removed);
    assert.doesNotMatch(serialized, /argHash|fileHash|reliability-hmac/);
    assert.doesNotMatch(serialized, /secret-command|secret-path|secret-skill-args|content-is-not-returned/);
    assert.doesNotMatch(serialized, /rollout-|transcriptPath|API-STRUCTURED-SECRET/);

    assert.doesNotMatch(serialized, /velocity-model-SENTINEL/);
    assert.doesNotMatch(serialized, /rollout-|transcriptPath/);
    assert.doesNotMatch(serialized, /secret-limit-payload/);
    assert.doesNotMatch(serialized, /SYNTHETIC-MODEL-SENTINEL/);
    assert.doesNotMatch(serialized, /"usedPercent"/);

    await t.test("wait values never change a ready cached snapshot", async () => {
      for (const wait of ["-1", "NaN", "Infinity", "nonnumeric", "999999999999", "0"]) {
        const response = await fetch(`${origin}/api/analytics?wait=${wait}`);
        assert.equal(response.status, 200, wait);
        assert.equal(await response.text(), serialized, wait);
      }
    });

    for (const path of ["/api/insights", "/api/review", "/workflow-data.js", "/metrics/outcomes-summary.js", "/workflow.js", "/workflow-scope.js", "/workflow-worker.js", "/workflow.css", "/views/insights.js", "/views/insights-state.js", "/views/insights.css", "/views/limits-cache.js", "/views/limits-cache.css", "/outcomes.js", "/outcomes-summary.js", "/outcomes.css", "/reliability-data.js", "/reliability-view.js", "/reliability.css"]) {
      assert.equal((await fetch(`${origin}${path}`)).status, 404, path);
    }

    const refreshed = await fetch(`${origin}/api/analytics?refresh=1`);
    assert.equal(refreshed.status, 200);
    await t.test("a browser launch failure logs only a fixed diagnostic", async () => {
      await waitFor(() => stderr.includes("Could not open the browser; open the dashboard URL manually."), () => "Browser failure was not reported.");
      assert.doesNotMatch(`${stdout}${stderr}`, /PRIVATE-BROWSER-SENTINEL/);
    });
    await t.test("concurrent refresh requests share one scan", async () => {
      const snapshots = await Promise.all(Array.from({ length: 6 }, async (_, index) => {
        const response = await fetch(`${origin}/api/analytics?refresh=1&wait=${index % 2 ? 30 : "NaN"}`);
        assert.equal(response.status, 200);
        return await response.json() as { generatedAt: string };
      }));
      assert.equal(new Set(snapshots.map((snapshot) => snapshot.generatedAt)).size, 1);
    });
    await t.test("?wait answers 202 while a scan runs, then the snapshot", async () => {
      // A worker process cannot finish within a millisecond, so the first answer is the pending one.
      const pending = await fetch(`${origin}/api/analytics?refresh=1&wait=0.001`);
      assert.equal(pending.status, 202);
      const body = await pending.json() as import("../src/types.ts").PendingAnalytics;
      assert.equal(body.pending, true);
      assert.ok(body.progress);
      assert.equal(body.progress.phase, "discover");
      assert.equal(body.progress.done, 0);
      assert.equal(body.progress.total, null);
      assert.equal(body.progress.fullParse, false);
      assert.ok(Number.isFinite(Date.parse(body.progress.startedAt)));
      const together = await Promise.all(["wait=10", "refresh=1&wait=20"].map(async (query) => {
        const response = await fetch(`${origin}/api/analytics?${query}`);
        assert.equal(response.status, 200);
        return (await response.json() as { generatedAt: string }).generatedAt;
      }));
      assert.equal(together[0], together[1], "refresh and cached reads join the scan already in progress");
      let response = await fetch(`${origin}/api/analytics?wait=10`);
      while (response.status === 202) response = await fetch(`${origin}/api/analytics?wait=10`);
      assert.equal(response.status, 200);
      assert.equal(((await response.json()) as { summary: { analyzedSessions: number } }).summary.analyzedSessions, 5 + unsafeModelSessions);
    });
    const page = await fetch(origin);
    assert.equal(page.status, 200);
    const pageText = await page.text();
    assert.match(pageText, /class="wordmark-text">Session <b>Analytics<\/b>/);
    assert.match(pageText, /<svg class="logo"[\s\S]*fill="#ececea"[\s\S]*fill="#b3b3ad"[\s\S]*fill="#858580"/);
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

    assert.match(pageText, /id="activity-tooltip"[\s\S]*role="tooltip"/);
    assert.match(pageText, /<dialog class="palette" id="command-palette"[\s\S]*role="combobox"[\s\S]*role="listbox"/);
    assert.match(pageText, /<dialog class="help" id="help-overlay"/);
    assert.match(pageText, /data-window-preset="30" aria-pressed="true"/);
    assert.match(pageText, /id="daily-provider-filters"/);
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
    assert.match(pageText, /aria-label="Filter daily usage by provider"/);
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
    assert.match(stylesheetText, /--heat-7:\s*#28282a/);
    assert.match(stylesheetText, /:root\[data-theme="dark"\][\s\S]*--heat-7:\s*#ececea/);
    assert.doesNotMatch(stylesheetText, /--heat-[1-7]:\s*#(?:9a7736|c85b45|c69a5d|d66b55)/);
    assert.match(stylesheetText, /--coral: #18181b;[\s\S]*--sage: #4f4f55;[\s\S]*--ochre: #858580;/);
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

    const launchAgain = async (flags: string[] = []): Promise<{ code: unknown; stdout: string; stderr: string }> => {
      const reused = spawn(process.execPath, [serverPath, "--port", String(port), ...flags], {
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
      return { code: reuseExitCode, stdout: reusedStdout, stderr: reusedStderr };
    };
    await t.test("an identical launch reuses the running dashboard", async () => {
      const reused = await launchAgain();
      assert.equal(reused.code, 0, reused.stderr);
      assert.match(reused.stdout, /Session Analytics already running:/);
      const normalized = await launchAgain(["--include-hidden", "--pricing-policy", "reviewed-first", "--pricing-max-age-days", "7", "--data-dir", join(childEnvironment.SESSION_ANALYTICS_DATA_DIR, ".")]);
      assert.equal(normalized.code, 0, normalized.stderr);
      assert.equal((await (await fetch(`${origin}/api/health`)).json() as Record<string, unknown>).instanceToken, healthBody.instanceToken);
    });
    await t.test("a second launch with different options refuses to reuse the port", async () => {
      for (const flags of [["--exclude-hidden"], ["--data-dir", join(temporaryDirectory, "other-data")], ["--rate-card", join(temporaryDirectory, "private-rate-card.json")]]) {
        const refused = await launchAgain(flags);
        assert.equal(refused.code, 1, refused.stderr);
        assert.equal(refused.stderr.trim(), "Session Analytics is already running on this port with different options; stop it or choose --port.");
        assert.equal(refused.stdout, "");
      }
    });
    await t.test("a health response without the matching private token cannot be reused", async () => {
      const tokenFile = join(childEnvironment.SESSION_ANALYTICS_DATA_DIR, `dashboard-${port}.token`);
      await writeFile(tokenFile, "0".repeat(64));
      assert.equal((await launchAgain()).code, 1);
      await rm(tokenFile);
      assert.equal((await launchAgain()).code, 1);
      await writeFile(tokenFile, String(healthBody.instanceToken), { mode: 0o600 });
      assert.equal((await launchAgain()).code, 0);
    });
  } finally {
    if (child) await stopServer(child);
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("a launch reuses only the same version with the same options and token", () => {
  const token = "a".repeat(64), hash = "b".repeat(64), scanHash = "e".repeat(64);
  const running = { service: "session-analytics", dataSource: "live", snapshot: "ready", status: "ok", instanceToken: token, optionsHash: hash, scanHash, version: "1.2.3" } as const;
  const expected = { version: "1.2.3", optionsHash: hash, scanHash, instanceToken: token };
  const options = "Session Analytics is already running on this port with different options; stop it or choose --port.";
  assert.equal(reuseRefusal(running, expected), null);
  assert.equal(reuseRefusal({ ...running, optionsHash: "c".repeat(64) }, expected),
    "Session Analytics is already running on this port with other machines (--remote, --machines or --no-remote differ); stop it or choose --port.", "only the machines differ");
  const { version: _omitted, ...unversioned } = running;
  assert.equal(reuseRefusal(unversioned, expected), "An older Session Analytics is running on this port; this is 1.2.3. Stop it (Ctrl+C where it runs) or choose --port.");
  assert.equal(reuseRefusal({ ...running, version: "1.2.2" }, expected), "An older Session Analytics (1.2.2) is running on this port; this is 1.2.3. Stop it (Ctrl+C where it runs) or choose --port.");
  assert.equal(reuseRefusal({ ...running, version: "1.10.0" }, expected), "A newer Session Analytics (1.10.0) is running on this port; this is 1.2.3. Stop it (Ctrl+C where it runs) or choose --port.");
  assert.equal(reuseRefusal({ ...running, version: "1.3.0-rc.1" }, expected), "A newer Session Analytics (1.3.0-rc.1) is running on this port; this is 1.2.3. Stop it (Ctrl+C where it runs) or choose --port.");
  assert.equal(reuseRefusal({ ...running, version: "1.2.3-rc.1" }, expected), "Another Session Analytics (1.2.3-rc.1) is running on this port; this is 1.2.3. Stop it (Ctrl+C where it runs) or choose --port.");
  for (const version of ["\u001b[2Jx; rm -rf /", "1.2.4-/Users/PRIVATE", 124 as unknown as string]) {
    assert.equal(reuseRefusal({ ...running, version }, expected), "Another Session Analytics is running on this port; this is 1.2.3. Stop it (Ctrl+C where it runs) or choose --port.", "only a release-grammar version is printed");
  }
  assert.equal(reuseRefusal({ ...running, version: "1.2.2" }, { ...expected, instanceToken: null }), "An older Session Analytics (1.2.2) is running on this port; this is 1.2.3. Stop it (Ctrl+C where it runs) or choose --port.");
  for (const health of [null, { ...running, optionsHash: "c".repeat(64), scanHash: "c".repeat(64) }, { ...running, instanceToken: "c".repeat(64) }, { ...running, dataSource: "snapshot" as const }, { ...running, service: "other" as "session-analytics" }]) {
    assert.equal(reuseRefusal(health, expected), options);
  }
  assert.equal(reuseRefusal(running, { ...expected, instanceToken: null }), options, "a saved-file launch never reuses");
});

test("a dashboard from another version on the port is named, not reused", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dashboard-version-"));
  const dataDir = join(directory, "data");
  const token = "d".repeat(64);
  let health: Record<string, unknown> = {};
  let rawBody: string | undefined;
  const older = createHttpServer((_request, response) => {
    if (rawBody === "slow") return;
    response.writeHead(200, { "Content-Type": "application/json" }); response.end(rawBody ?? JSON.stringify(health));
  });
  try {
    await new Promise<void>((resolve) => older.listen(0, "127.0.0.1", resolve));
    const address = older.address();
    assert.ok(address && typeof address === "object");
    writeDashboardToken({ dataDir }, address.port, token);
    const launch = async (): Promise<{ code: unknown; stdout: string; stderr: string }> => {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:CLAUDE_CONFIG_DIR|CODEX_HOME|SESSION_ANALYTICS_|CONDUCTOR_)/.test(key)));
      const child = spawn(process.execPath, [serverPath, "--port", String(address.port), "--data-dir", dataDir, "--no-index", "--offline"], { cwd: repositoryRoot, env: { ...env, HOME: directory }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      const [code] = await once(child, "exit");
      return { code, stdout, stderr };
    };
    // A 0.9.0 dashboard reports no version but would otherwise pass every reuse check.
    health = { service: "session-analytics", dataSource: "live", snapshot: "ready", status: "ok", instanceToken: token, optionsHash: "0".repeat(64) };
    const refused = await launch();
    assert.equal(refused.code, 1);
    assert.equal(refused.stdout, "");
    assert.equal(refused.stderr, `An older Session Analytics is running on this port; this is ${version}. Stop it (Ctrl+C where it runs) or choose --port.\n`);
    health = { ...health, version: "999.0.0" };
    assert.match((await launch()).stderr, /^A newer Session Analytics \(999\.0\.0\) is running on this port/);
    for (const body of ["null", "[]", '"PRIVATE-HEALTH-SENTINEL"', "invalid JSON PRIVATE-HEALTH-SENTINEL", "slow"]) {
      rawBody = body;
      const refused = await launch();
      assert.equal(refused.code, 1, body);
      assert.equal(refused.stdout, "");
      assert.equal(refused.stderr, "Session Analytics is already running on this port with different options; stop it or choose --port.\n");
    }
  } finally {
    older.closeAllConnections();
    await new Promise<void>((resolve) => older.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("dashboard tokens rotate per port and reject links or insecure permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dashboard-token-"));
  const options = { dataDir: join(directory, "data") };
  const path = join(options.dataDir, "dashboard-4174.token");
  const first = "1".repeat(64), second = "2".repeat(64);
  try {
    writeDashboardToken(options, 4174, first);
    writeDashboardToken(options, 4175, first);
    writeDashboardToken(options, 4174, second);
    assert.equal(readDashboardToken(options, 4174), second);
    assert.equal(readDashboardToken(options, 4175), first);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await chmod(path, 0o644);
    assert.throws(() => readDashboardToken(options, 4174));
    await chmod(path, 0o600);
    const target = join(directory, "target");
    await link(path, target);
    assert.throws(() => readDashboardToken(options, 4174));
    assert.throws(() => writeDashboardToken(options, 4174, first));
    await rm(path);
    await symlink(target, path);
    assert.throws(() => readDashboardToken(options, 4174));
    assert.throws(() => writeDashboardToken(options, 4174, first));
    assert.equal(await readFile(target, "utf8"), second, "linked targets are never overwritten");
    const linkedDirectory = join(directory, "linked-data");
    await symlink(options.dataDir, linkedDirectory);
    assert.throws(() => readDashboardToken({ dataDir: linkedDirectory }, 4175));
    assert.throws(() => writeDashboardToken({ dataDir: linkedDirectory }, 4175, second));
    await chmod(options.dataDir, 0o755);
    assert.throws(() => readDashboardToken(options, 4175));
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("pending analytics exposes only current worker counters through both scan paths", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "server-progress-"));
  try {
    const fixture = await createSessionAnalyticsFixture(root);
    const { analyzeMachineSessions } = await import("../src/analyzer.ts");
    const snapshot = await analyzeMachineSessions({ ...fixture, noIndex: true, additionalProviders: false, offline: true });
    const snapshotPath = join(root, "snapshot.json");
    await writeFile(snapshotPath, JSON.stringify(snapshot));
    for (const savedMachines of [false, true]) await t.test(savedMachines ? "saved machines" : "local only", async () => {
      const dataDir = join(root, savedMachines ? "machines" : "local");
      const { writeMachines } = await import("../src/machines/config.ts");
      writeMachines({ dataDir }, { version: 1, machines: savedMachines ? [{ name: "test", ssh: "test", runtime: "installed", enabled: true }] : [] });
      const worker = join(dataDir, "slow-worker.mjs"), preload = join(dataDir, "preload.mjs");
      await writeFile(worker, `import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
for await (const chunk of process.stdin) {}
const scan = process.argv[2], root = ${JSON.stringify(dataDir)};
if (scan === "1") process.stderr.write(${JSON.stringify("session-analytics:full-parse\n")});
process.stderr.write(${JSON.stringify('session-analytics:progress {"phase":"parse","done":27,"total":100}\n')});
writeFileSync(root + "/ready-" + scan, "");
while (!existsSync(root + "/release-" + scan)) await delay(10);
process.stdout.write(readFileSync(${JSON.stringify(snapshotPath)}));
`);
      await writeFile(preload, `import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const spawn = childProcess.spawn;
let scans = 0;
childProcess.spawn = (command, args, options) => args.some((arg) => /analysis-worker\.(ts|js)$/.test(arg))
  ? spawn(process.execPath, [${JSON.stringify(worker)}, String(++scans)], options)
  : command === "ssh" ? spawn(process.execPath, ["-e", "process.exit(1)"], options) : spawn(command, args, options);
syncBuiltinESMExports();
`);
      const port = await availablePort(), origin = `http://127.0.0.1:${port}`;
      const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, serverPath, "--no-open", "--offline", "--port", String(port), "--data-dir", dataDir], { env: { ...process.env, HOME: root }, stdio: ["ignore", "pipe", "pipe"] });
      let output = "", diagnostics = "";
      child.stdout!.on("data", (chunk) => { output += chunk; }); child.stderr!.on("data", (chunk) => { diagnostics += chunk; });
      try {
        const ready = async (scan: number) => await waitFor(async () => !!await stat(join(dataDir, `ready-${scan}`)).catch(() => null), () => `No slow worker: ${output} ${diagnostics}`);
        await ready(1);
        const pending = async () => {
          const response = await fetch(`${origin}/api/analytics?wait=0.001`);
          assert.equal(response.status, 202);
          return await response.json() as import("../src/types.ts").PendingAnalytics;
        };
        const first = await pending();
        assert.equal(first.pending, true);
        assert.ok(first.progress);
        assert.deepEqual(Object.keys(first).sort(), ["pending", "progress"]);
        assert.deepEqual(first.progress, { phase: "parse", done: 27, total: 100, startedAt: first.progress.startedAt, fullParse: true });
        assert.ok(Number.isFinite(Date.parse(first.progress.startedAt)));
        assert.deepEqual(await pending(), first, "polling shares the scan start and counters");
        assert.doesNotMatch(JSON.stringify(first), /PRIVATE_|secret|rollout|test|path|sessionKey/);
        await writeFile(join(dataDir, "release-1"), "");
        assert.equal((await fetch(`${origin}/api/analytics?wait=10`)).status, 200);
        const refresh = fetch(`${origin}/api/analytics?refresh=1&wait=10`);
        await ready(2);
        const second = await pending();
        assert.ok(second.progress);
        assert.equal(second.progress.fullParse, false, "a new scan clears the full-parse flag");
        assert.notEqual(second.progress.startedAt, first.progress.startedAt);
        await writeFile(join(dataDir, "release-2"), "");
        assert.equal((await refresh).status, 200);
        assert.equal((await fetch(`${origin}/api/analytics?wait=0.001`)).status, 200);
      } finally { await stopServer(child); }
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});
