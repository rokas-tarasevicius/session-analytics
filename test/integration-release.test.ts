import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { validateSnapshot } from "../src/interop/snapshot.ts";
import { Element, Option, documentFromHtml } from "./release-dom.ts";
import { version } from "../src/version.ts";
import { checkPackageFiles, checkPackageManifest, checkReleaseMetadata, extractReleaseNotes } from "../scripts/release-check.ts";
import { build } from "../scripts/build.ts";
import { staticRoutes } from "../src/static-routes.ts";

const views = ["summary", "velocity", "costs", "pricing", "subscription", "tools", "activity"];
const forbidden = /PRIVATE_DEMO_CONTENT_SENTINEL|synthetic demo prompt|synthetic demo response|synthetic tool result|synthetic-demo-only|session-analytics-demo-|\/repos\/|\/projects\//;

test("release: package, lockfile, CLI and latest changelog versions agree", async () => {
  const [manifest, lockfile, changelog] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
    readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8"),
  ]);
  const latest = /^## \[(\d+\.\d+\.\d+)\](?:\s|$)/m.exec(changelog);
  assert.ok(latest, "CHANGELOG.md must have a released version heading");
  assert.equal(JSON.parse(manifest).version, version, "package.json matches src/version.ts");
  assert.equal(JSON.parse(lockfile).version, version, "package-lock.json matches src/version.ts");
  assert.equal(latest[1], version, "latest CHANGELOG.md release matches src/version.ts");
});

test("release: every CI event uses hosted Linux and macOS with required browser checks", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const [check, browser] = workflow.split("\n  browser:\n");
  assert.ok(check && browser);
  const matrix = /^        os: \[([^\]]+)\]$/m.exec(check)?.[1];
  assert.ok(matrix, "all events share a fixed hosted runner matrix");
  assert.deepEqual(matrix.split(",").map((runner) => runner.trim()), ["ubuntu-latest", "macos-latest"]);
  assert.match(check, /name: check \(\$\{\{ matrix.os \}\}\)/);
  assert.match(workflow, /on:\n  push:\n    branches: \[master\]\n  pull_request:\n  workflow_dispatch:/);
  assert.doesNotMatch(workflow, /agentbox|self-hosted|repository\.private|continue-on-error/);
  assert.doesNotMatch(check, /^    if:/m, "platform checks cannot skip any supported event");
  assert.match(check, /permissions:\n  contents: read/);
  assert.match(check, /concurrency:\n  group: ci-.*\n  cancel-in-progress: true/);
  assert.match(check, /run: npm run release:check/);
  assert.match(browser, /name: browser \(ubuntu-latest\)/);
  assert.match(browser, /runs-on: ubuntu-latest/);
  assert.doesNotMatch(browser, /^    if:/m, "browser checks cannot skip private repositories or pull requests");
  assert.match(browser, /SESSION_ANALYTICS_REQUIRE_BROWSER: '1'/);
  assert.match(browser, /run: npm run test:browser/);
  assert.match(browser, /SESSION_ANALYTICS_CHROME: \/usr\/bin\/google-chrome/);
  for (const job of [check, browser]) {
    assert.match(job, /persist-credentials: false/);
    assert.match(job, /node-version: 24/);
    assert.match(job, /run: npm ci/);
  }
  assert.doesNotMatch(workflow, /pull_request_target/);
});

test("release: tag publication follows a read-only validation job", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.match(workflow, /on:\n  push:\n    tags: \['v\*'\]/);
  assert.match(workflow, /permissions:\n  contents: read/);
  const [validation, publishing] = workflow.split("\n  release:\n");
  assert.ok(validation && publishing);
  assert.doesNotMatch(validation, /contents: write/);
  assert.match(validation, /run: npm run release:check/);
  assert.match(validation, /run: node scripts\/release-check.ts --notes "\$GITHUB_REF_NAME"/);
  assert.match(publishing, /needs: \[validate, browser\]/);
  assert.match(publishing, /permissions:\n      contents: write/);
  assert.match(publishing, /run: node scripts\/release-check.ts --notes "\$GITHUB_REF_NAME"/);
  assert.doesNotMatch(publishing, /npm ci|npm run/);
  assert.match(publishing, /runs-on: ubuntu-latest/);
  assert.match(publishing, /name: publish release/);
  assert.doesNotMatch(workflow, /agentbox|self-hosted|repository\.private|continue-on-error/);
  const matrix = /^        os: \[([^\]]+)\]$/m.exec(validation)?.[1];
  assert.ok(matrix);
  assert.deepEqual(matrix.split(",").map((runner) => runner.trim()), ["ubuntu-latest", "macos-latest"]);
  assert.match(validation, /name: release validation \(\$\{\{ matrix.os \}\}\)/);
  const browser = validation.split("\n  browser:\n")[1];
  assert.ok(browser);
  assert.match(browser, /name: release browser \(ubuntu-latest\)/);
  assert.match(browser, /runs-on: ubuntu-latest/);
  assert.doesNotMatch(browser, /^    if:/m, "tag browser checks cannot be skipped for private previews");
  assert.match(validation, /SESSION_ANALYTICS_REQUIRE_BROWSER: '1'/);
  assert.doesNotMatch(validation, /continue-on-error/);
  const gate = /^    if: \$\{\{ (.*) \}\}$/m.exec(publishing)?.[1];
  assert.ok(gate);
  const canPublish = new Function("needs", "cancelled", `return ${gate};`);
  for (const platformResult of ["success", "failure", "skipped", "cancelled"]) for (const browserResult of ["success", "failure", "skipped", "cancelled"]) {
    const needs = { validate: { result: platformResult }, browser: { result: browserResult } };
    assert.equal(canPublish(needs, () => false), platformResult === "success" && browserResult === "success", `validate=${platformResult}, browser=${browserResult}`);
    assert.equal(canPublish(needs, () => true), false, "cancelled workflow never publishes");
  }
  assert.match(publishing, /GH_TOKEN: \$\{\{ github.token \}\}/);
});

test("release: notes exclude unreleased and older changes; mismatched tags and metadata fail", () => {
  const metadata = {
    packageVersion: "1.2.3", lockVersion: "1.2.3", lockRootVersion: "1.2.3", sourceVersion: "1.2.3",
    changelog: "# Changelog\n\n## [Unreleased]\n\n- Pending.\n\n## [1.2.3] - 2026-10-13\n\n### Changed\n\n- Current notes.\n\n## [1.2.2]\n\n- Older notes.\n",
  };
  assert.equal(extractReleaseNotes(metadata, "v1.2.3"), "### Changed\n\n- Current notes.\n");
  for (const tag of ["v1.2.2", "v9.9.9", "v1.2", "1.2.3", "v1.2.3-beta.1"]) assert.throws(() => extractReleaseNotes(metadata, tag), /Release tag must be/);
  for (const field of ["packageVersion", "lockVersion", "lockRootVersion"] as const) assert.throws(() => checkReleaseMetadata({ ...metadata, [field]: "1.2.2" }), /does not match source/);
  assert.throws(() => checkReleaseMetadata({ ...metadata, changelog: "## [1.2.2]\n- Old" }), /Latest changelog/);
  assert.throws(() => extractReleaseNotes({ ...metadata, changelog: "## [1.2.3]\n\n### Changed\n" }, "v1.2.3"), /no release notes/);
});

test("release: the compiled package carries workers, served files and notices, and installs without running anything", { timeout: 120_000 }, async () => {
  const out = await mkdtemp(join(tmpdir(), "session-analytics-build-"));
  try {
    build(out);
    const result = spawnSync("npm", ["pack", out, "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    const files: string[] = JSON.parse(result.stdout)[0].files.map((file: { path: string }) => file.path);
    checkPackageFiles(files);
    for (const extra of [".env", "src/.env", "data/sessions.jsonl", "data/local.sqlite", "test/fixtures.ts", "assets/private.png", "src/../secret.ts",
      "src/analyzer.ts", "src/public/format.d.ts", "src/server.js.map", "bin/session-analytics.ts", ".DS_Store"]) {
      assert.throws(() => checkPackageFiles([...files, extra]), /Unexpected package file/, extra);
    }
    for (const missing of ["src/analysis-worker.js", "src/cursor-worker.js", "src/mcp/worker.js", "src/public/fonts/OFL-1.1.txt", "src/public/subscription.css", "CHANGELOG.md"]) {
      assert.throws(() => checkPackageFiles(files.filter((path) => path !== missing)), /Package is missing/, missing);
    }
    const manifest = JSON.parse(await readFile(join(out, "package.json"), "utf8")) as Record<string, unknown>;
    const binSource = await readFile(join(out, "bin/session-analytics.js"), "utf8");
    checkPackageManifest(manifest, binSource, version);
    for (const [field, value] of [["scripts", { postinstall: "x" }], ["dependencies", { left: "1" }], ["private", true], ["version", "0.0.1"], ["bin", { "session-analytics": "bin/session-analytics.ts" }], ["os", ["darwin"]]] as const) {
      assert.throws(() => checkPackageManifest({ ...manifest, [field]: value }, binSource, version), Error, field);
    }
    assert.throws(() => checkPackageManifest(manifest, binSource.replace("#!/usr/bin/env node\n", ""), version), /#!\/usr\/bin\/env node/);
    const root = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as Record<string, unknown>;
    assert.equal(root["private"], true, "the TypeScript source layout can never be published by accident");
    assert.equal(root["version"], manifest["version"]);
  } finally { await rm(out, { recursive: true, force: true }); }
});

test("release: every dispatcher command shares help and version without scanning", () => {
  for (const command of ["dashboard", "report", "rates", "export", "merge", "index", "mcp", "limits"]) {
    const help = spawnSync(process.execPath, ["bin/session-analytics.ts", command, "--help"], { encoding: "utf8" });
    assert.equal(help.status, 0, `${command}: ${help.stderr}`); assert.match(help.stdout, /session-analytics/i);
    const result = spawnSync(process.execPath, ["bin/session-analytics.ts", command, "--version"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), version);
  }
  // Removed commands and options fail as unknown instead of being silently accepted.
  for (const command of ["insights", "review"]) assert.equal(spawnSync(process.execPath, ["bin/session-analytics.ts", command, "--help"], { encoding: "utf8" }).status, 2, command);
  for (const flag of ["--reliability-content-rules", "--outcomes-git", "--outcomes-github", "--workflow-content-rules", "--insights-config"]) {
    assert.equal(spawnSync(process.execPath, ["bin/session-analytics.ts", "report", flag, ...(flag === "--insights-config" ? ["x"] : [])], { encoding: "utf8" }).status, 2, flag);
  }
});

test("release: complete demo API, all six renderers, static modules and privacy work together", { timeout: 120_000 }, async (t) => {
  const listener = createServer(); await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address(); assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const base = `http://127.0.0.1:${address.port}`;
  const child = spawn(process.execPath, ["scripts/demo.ts", "--no-open", "--port", String(address.port)], { stdio: ["ignore", "pipe", "pipe"] });
  let errors = ""; child.stderr.on("data", (chunk) => { errors += String(chunk); });
  const globals = globalThis as unknown as Record<string, any>;
  const originals = Object.fromEntries(["document", "window", "Option", "HTMLElement", "fetch"].map((key) => [key, globals[key]]));
  const realFetch = fetch;
  try {
    let ready = false;
    for (let i = 0; i < 200; i++) {
      assert.equal(child.exitCode, null, errors);
      try { ready = (await realFetch(`${base}/api/health`)).ok; } catch { /* Starting. */ }
      if (ready) break; await delay(100);
    }
    assert.ok(ready, "Demo server did not start");
    const response = await realFetch(`${base}/api/analytics`); assert.equal(response.status, 200, await response.clone().text());
    const raw = await response.text(); assert.doesNotMatch(raw, forbidden);
    const snapshot = validateSnapshot(JSON.parse(raw));
    assert.ok(snapshot.sessions.length > 100); assert.ok(snapshot.repositories.length >= 6);
    for (const provider of ["claude", "codex", "cursor", "copilot", "opencode", "gemini"]) assert.ok(snapshot.sessions.some((s) => s.provider === provider), provider);
    for (const key of ["velocity", "historyProfile", "mcpEvidence"] as const) assert.ok(snapshot.sessions.some((s) => s[key]), key);
    assert.ok(snapshot.spendByModel.some((m) => m.pricing?.length));
    const refreshed = await realFetch(`${base}/api/analytics?refresh=1`);
    assert.equal(refreshed.status, 200);
    const warm = validateSnapshot(await refreshed.json());
    assert.deepEqual(warm.sessions, snapshot.sessions, "warm demo replays every provider and namespace");
    // Cover the exact server allowlist, including modules imported transitively by views.
    const assets = staticRoutes.map(([route]) => route);
    for (const asset of ["/export-data.js", "/chart-colors.js", "/chart-legend.js", "/chart-scale.js"]) assert.ok(assets.includes(asset), asset);
    for (const asset of assets) { const r = await realFetch(base + asset); assert.equal(r.status, 200, asset); assert.ok((await r.arrayBuffer()).byteLength, asset); }
    const html = await (await realFetch(base)).text();
    const document = documentFromHtml(html), storage = { getItem: () => null, setItem() {} };
    const window = { matchMedia: () => ({ matches: false, addEventListener() {} }), localStorage: storage, setTimeout, clearTimeout, innerWidth: 1440 };
    const boundFetch = (url: string | URL, init?: RequestInit) => realFetch(new URL(String(url), base), init);
    Object.assign(globals, { document, window, Option, HTMLElement: Element, fetch: boundFetch });
    const app = await readFile(new URL("../src/public/app.js", import.meta.url), "utf8");
    const helpers: Record<string, any> = {};
    for (const [, specifiers, path] of app.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*["']([^"']+)["'];/g)) {
      const exports = await import(new URL(`../src/public/${path!.replace(/^\.\//, "")}`, import.meta.url).href);
      for (const name of specifiers!.split(",").map((s) => s.trim()).filter(Boolean)) helpers[name] = exports[name];
    }
    const source = app.replace(/^import[\s\S]*?from ["'][^"']+["'];\n/gm, "").split("const urlParameters =")[0]!;
    const context = { ...helpers, document, window, HTMLElement: Element, Option, URLSearchParams, localStorage: storage, fetch: boundFetch,
      setTimeout, clearTimeout, resetExportMenu: () => {}, fixture: snapshot, CSS: { escape: (s: string) => s } };
    const api = runInNewContext(source + `\nsnapshot = fixture; sessionsByRepository = groupByRepository(snapshot.sessions);
      elements.repositoryFilter.value = 'all';
      elements.windowStart.value = elements.windowStart.min = '2026-01-01'; elements.windowEnd.value = elements.windowEnd.max = snapshot.generatedAt.slice(0,10);
      applyUrlAfterRender = () => {};
      ({ switchView, activeView, paletteItems, viewChords, viewOrder, renderSharedView });`, context);
    assert.deepEqual([...api.viewOrder], views);
    assert.equal(new Set(Object.values(api.viewChords)).size, views.length);
    assert.equal(document.querySelectorAll("[data-view-button]").length, views.length);
    assert.equal(api.paletteItems().filter((i: any) => i.group === "Views").length, views.length);
    assert.deepEqual([...api.paletteItems()].filter((i: any) => i.group === "Views").map((i: any) => i.keywords), views.map((view) => `view ${view}`));
    for (const view of views) {
      api.switchView(view);
      assert.equal(document.querySelector("#page-title")!.textContent.trim().length > 0, true, view);
      assert.equal(document.querySelector(`[data-view-panel="${view}"]`)!.hidden, false, view);
      const rendered = document.body.textContent;
      assert.doesNotMatch(rendered, forbidden, view); assert.doesNotMatch(rendered, /NaN|Infinity/, view);
    }
    t.diagnostic(JSON.stringify({ sessions: snapshot.sessions.length, repositories: snapshot.repositories.length, views: views.length, staticAssets: assets.length, bytes: Buffer.byteLength(raw) }));
  } finally {
    for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globals[key]; else globals[key] = value; }
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await Promise.race([exited, delay(5000)]); }
  }
});
