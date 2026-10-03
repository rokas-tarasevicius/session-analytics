import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { validateSnapshot } from "../src/interop/snapshot.ts";
import { Element, Option, documentFromHtml } from "./release-dom.ts";
import { version } from "../src/version.ts";

const views = ["summary", "distributions", "activity", "velocity", "costs", "models", "pricing", "reliability", "limits-cache", "workflow", "tools", "skills", "outcomes", "insights"];
const forbidden = /PRIVATE_DEMO_CONTENT_SENTINEL|synthetic demo prompt|synthetic demo response|synthetic tool result|synthetic-demo-only|session-analytics-demo-|\/repos\/|\/projects\//;

test("release: every dispatcher command shares help and version without scanning", () => {
  for (const command of ["dashboard", "report", "rates", "insights", "review", "export", "merge", "index", "mcp"]) {
    const help = spawnSync(process.execPath, ["bin/session-analytics.ts", command, "--help"], { encoding: "utf8" });
    assert.equal(help.status, 0, `${command}: ${help.stderr}`); assert.match(help.stdout, /session-analytics/i);
    const result = spawnSync(process.execPath, ["bin/session-analytics.ts", command, "--version"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), version);
  }
});

test("release: complete demo API, all fourteen renderers, static modules and privacy work together", { timeout: 120_000 }, async (t) => {
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
    for (const key of ["velocity", "reliability", "limitsCache", "outcomes", "workflow", "insightSignals", "mcpEvidence"] as const) assert.ok(snapshot.sessions.some((s) => s[key]), key);
    assert.ok(snapshot.spendByModel.some((m) => m.pricing?.length));
    const refreshed = await realFetch(`${base}/api/analytics?refresh=1`);
    assert.equal(refreshed.status, 200);
    const warm = validateSnapshot(await refreshed.json());
    assert.deepEqual(warm.sessions, snapshot.sessions, "warm demo replays every provider and namespace");
    const insights = await realFetch(`${base}/api/insights`); assert.equal(insights.status, 200); assert.doesNotMatch(await insights.text(), forbidden);
    // Cover the exact server allowlist, including modules imported transitively by views.
    const server = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");
    const staticBlock = server.slice(server.indexOf("const staticFiles ="), server.indexOf("let analyticsPromise"));
    const assets = [...staticBlock.matchAll(/\["(\/[^"\n]*)",\s*join\(/g)].map((m) => m[1]!);
    assert.ok(assets.length >= 35);
    for (const asset of assets) { const r = await realFetch(base + asset); assert.equal(r.status, 200, asset); assert.ok((await r.arrayBuffer()).byteLength, asset); }
    const html = await (await realFetch(base)).text();
    const document = documentFromHtml(html), storage = { getItem: () => null, setItem() {} };
    const window = { matchMedia: () => ({ matches: false, addEventListener() {} }), localStorage: storage, setTimeout, clearTimeout, innerWidth: 1440 };
    const boundFetch = (url: string | URL, init?: RequestInit) => realFetch(new URL(String(url), base), init);
    Object.assign(globals, { document, window, Option, HTMLElement: Element, fetch: boundFetch });
    const app = await readFile(new URL("../src/public/app.js", import.meta.url), "utf8");
    const helpers: Record<string, any> = {};
    for (const [, specifiers, path] of app.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*["']([^"']+)["'];/g)) {
      let exports;
      if (path === "./outcomes.js") {
        const source = (await readFile(new URL("../src/public/outcomes.js", import.meta.url), "utf8")).replace('"./outcomes-summary.js"', JSON.stringify(new URL("../src/metrics/outcomes-summary.js", import.meta.url).href)).replace('"./ui.js"', JSON.stringify(new URL("../src/public/ui.js", import.meta.url).href));
        exports = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
      } else exports = await import(new URL(`../src/public/${path!.replace(/^\.\//, "").replace(/^\//, "")}`, import.meta.url).href);
      for (const name of specifiers!.split(",").map((s) => s.trim()).filter(Boolean)) helpers[name] = exports[name];
    }
    const source = app.replace(/^import[\s\S]*?from ["'][^"']+["'];\n/gm, "").split("const urlParameters =")[0]!;
    const context = { ...helpers, document, window, HTMLElement: Element, Option, URLSearchParams, localStorage: storage, fetch: boundFetch,
      setTimeout, clearTimeout, resetExportMenu: () => {}, fixture: snapshot, CSS: { escape: (s: string) => s } };
    const api = runInNewContext(source + `\nsnapshot = fixture; sessionsByRepository = groupByRepository(snapshot.sessions);
      elements.repositoryFilter.value = 'all'; elements.workflowProvider?.value;
      elements.windowStart.value = elements.windowStart.min = '2026-01-01'; elements.windowEnd.value = elements.windowEnd.max = snapshot.generatedAt.slice(0,10);
      applyUrlAfterRender = () => {};
      ({ switchView, activeView, paletteItems, viewChords, viewOrder, renderSharedView });`, context);
    document.querySelector("#workflow-provider")!.value = "all";
    assert.deepEqual([...api.viewOrder], views);
    assert.equal(new Set(Object.values(api.viewChords)).size, 14);
    assert.equal(document.querySelectorAll("[data-view-button]").length, 14);
    assert.equal(api.paletteItems().filter((i: any) => i.group === "Views").length, 14);
    for (const view of views) {
      api.switchView(view);
      // Await async Insights/Workflow through their actual API/aggregate paths.
      if (view === "workflow") await helpers.renderWorkflow(api.activeView(), snapshot);
      if (view === "insights") await helpers.renderInsights(document.querySelector("#insights-root"), { repositories: snapshot.repositories, generatedAt: snapshot.generatedAt });
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
