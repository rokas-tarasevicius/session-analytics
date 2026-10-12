import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { validateSnapshot } from "../src/interop/snapshot.ts";
import { Element, Option, documentFromHtml } from "./release-dom.ts";
import { version } from "../src/version.ts";

const views = ["summary", "velocity", "costs", "pricing", "tools", "activity"];
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

test("release: CI gates run on both platforms with independent advisory browser checks", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const [check, browser] = workflow.split("\n  browser:\n");
  assert.ok(check && browser);
  assert.match(check, /os: \[ubuntu-latest, macos-latest\]/);
  assert.match(check, /permissions:\n  contents: read/);
  assert.match(check, /concurrency:\n  group: ci-.*\n  cancel-in-progress: true/);
  const commands = ["npm run check", "node scripts/snapshot-schema.ts --check", 'node scripts/demo.ts report --json | node -e \'JSON.parse(require("fs").readFileSync(0, "utf8"))\'', "npm pack --dry-run"];
  const runs = [...check.matchAll(/^        run: (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(runs, ["npm ci", ...commands]);
  assert.match(browser, /runs-on: macos-latest\n    continue-on-error: true/);
  assert.doesNotMatch(workflow, /\bneeds:/);
  assert.match(browser, /run: node --test test\/dashboard\.browser\.test\.ts/);
  for (const job of [check, browser]) {
    assert.match(job, /uses: actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\n        with:\n          persist-credentials: false/);
    assert.match(job, /uses: actions\/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7\n        with:\n          node-version: 24/);
    assert.match(job, /run: npm ci/);
  }
});

test("release: tag workflow extracts only matching changelog notes and rejects missing sections", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.match(workflow, /on:\n  push:\n    tags: \['v\*'\]/);
  assert.match(workflow, /permissions:\n  contents: write/);
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /run: npm ci[\s\S]*run: npm run check[\s\S]*name: Extract release notes[\s\S]*name: Create GitHub Release/);
  assert.match(workflow, /run: gh release create "\$GITHUB_REF_NAME" --title "\$GITHUB_REF_NAME" --notes-file notes\.md\n        env:\n          GH_TOKEN: \$\{\{ github.token \}\}/);
  const block = /      - name: Extract release notes\n        run: \|\n([\s\S]*?)\n      - name: Create GitHub Release/.exec(workflow);
  assert.ok(block, "release workflow has an extraction script");
  const script = block[1]!.split("\n").map((line) => line.replace(/^          /, "")).join("\n");
  const root = await mkdtemp(join(tmpdir(), "session-analytics-release-"));
  try {
    await writeFile(join(root, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\nPending.\n\n## [1.2.3] - 2026-10-12\n\n### Changed\n\n- Current notes.\n\n## [1.2.2]\n\n- Older notes.\n");
    for (const [tag, notes] of [["v1.2.3", "### Changed\n\n- Current notes.\n"], ["v1.2.2", "- Older notes.\n"]]) {
      const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], { cwd: root, env: { ...process.env, GITHUB_REF_NAME: tag }, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(await readFile(join(root, "notes.md"), "utf8"), notes);
    }
    for (const tag of ["v9.9.9", "v1.2"]) {
      const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], { cwd: root, env: { ...process.env, GITHUB_REF_NAME: tag }, encoding: "utf8" });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /No CHANGELOG\.md section found for/);
      assert.equal(await readFile(join(root, "notes.md"), "utf8"), "- Older notes.\n", "missing section does not overwrite notes");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release: every dispatcher command shares help and version without scanning", () => {
  for (const command of ["dashboard", "report", "rates", "export", "merge", "index", "mcp"]) {
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
    const server = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");
    const staticBlock = server.slice(server.indexOf("const staticFiles ="), server.indexOf("let analyticsPromise"));
    const assets = [...staticBlock.matchAll(/\["(\/[^"\n]*)",\s*join\(/g)].map((m) => m[1]!);
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
