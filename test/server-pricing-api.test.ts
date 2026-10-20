import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createSessionAnalyticsFixture } from "./fixtures.ts";
import type { MachineAnalytics, DashboardHealth } from "../src/types.ts";
import { pricingDirectory, saveSnapshot } from "../src/pricing/store.ts";
import { privateSentinel, sourceSnapshot } from "./pricing-fixtures.ts";

for (const maxAgeDays of [0, 7]) test(`API refresh shares pricing before scanning (${maxAgeDays === 0 ? "stale source" : "newly observed model with a fresh source"})`, { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "server-pricing-api-"));
  const fixture = await createSessionAnalyticsFixture(directory);
  if (maxAgeDays === 7) await saveSnapshot(pricingDirectory({ dataDir: join(directory, "data") }),
    sourceSnapshot("models.dev", new Date(Date.now() - 2 * 86400000).toISOString()));
  let started!: () => void, release!: () => void, failed = false, requests = 0;
  const fetching = new Promise<void>((done) => { started = done; });
  const gate = new Promise<void>((done) => { release = done; });
  const feed = createServer(async (_request, response) => {
    requests++; started(); await gate;
    response.end(failed ? privateSentinel : JSON.stringify({ anthropic: { models: {
      "claude-pricing-new": { cost: { input: 2, output: 10 }, description: privateSentinel },
    } } }));
  });
  await new Promise<void>((done) => feed.listen(0, "127.0.0.1", done));
  const feedAddress = feed.address(); assert.ok(feedAddress && typeof feedAddress !== "string");
  // Reserve an ephemeral loopback port; no fixed demo ports or public network requests.
  const probe = createServer(); await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const address = probe.address(); assert.ok(address && typeof address !== "string");
  await new Promise<void>((done) => probe.close(() => done()));
  const preload = join(directory, "loopback.mjs");
  await writeFile(preload, `const original = globalThis.fetch;
globalThis.fetch = (url, options) => {
  if (String(url) !== 'https://models.dev/api.json') throw Error('Unexpected public request');
  return original(${JSON.stringify(`http://127.0.0.1:${feedAddress.port}/prices`)}, options);
};\n`);
  await appendFile(join(fixture.claudeRoot, "-fixtures-workspaces-conductor-claude-workspace", "22222222-2222-4222-8222-222222222222.jsonl"), [
    { type: "user", timestamp: "2026-10-20T10:00:00Z", message: { role: "user", content: privateSentinel } },
    { type: "assistant", timestamp: "2026-10-20T10:00:01Z", message: { id: "fixture-pricing", model: "claude-pricing-new",
      usage: { input_tokens: 1000000, output_tokens: 100000 }, content: [{ type: "text", text: privateSentinel }] } },
  ].map((value) => JSON.stringify(value)).join("\n") + "\n");
  const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, "src/server.ts", "--port", String(address.port),
    "--no-open", "--no-remote", "--no-codex-account", "--pricing-sources", "models.dev", "--pricing-max-age-days", String(maxAgeDays)], {
    env: { ...process.env, SESSION_ANALYTICS_OFFLINE: "0", SESSION_ANALYTICS_NO_INDEX: "1", SESSION_ANALYTICS_ADDITIONAL_PROVIDERS: "0",
      SESSION_ANALYTICS_DATA_DIR: join(directory, "data"), SESSION_ANALYTICS_CLAUDE_ROOT: fixture.claudeRoot,
      SESSION_ANALYTICS_CODEX_ROOT: fixture.codexRoot, SESSION_ANALYTICS_CODEX_ARCHIVE_ROOT: fixture.codexArchiveRoot,
      SESSION_ANALYTICS_CURSOR_DATABASE: fixture.cursorDatabasePath, SESSION_ANALYTICS_CONDUCTOR_DATABASE: fixture.databasePath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    for (let attempt = 0; !stdout.includes("ready:") && attempt < 200; attempt++) await delay(20);
    assert.match(stdout, /ready:/, stderr);
    const initial = await fetch(`${origin}/api/analytics`).then((response) => response.json() as Promise<MachineAnalytics>);
    const initialUsage = initial.sessions.flatMap((session) => session.models).find((model) => model.model === "claude-pricing-new");
    assert.ok(initialUsage); assert.equal(initialUsage.priced, false);
    await fetching;
    assert.equal((await fetch(`${origin}/api/analytics`).then((response) => response.json() as Promise<MachineAnalytics>)).generatedAt, initial.generatedAt);
    if (maxAgeDays === 7) {
      release();
      for (let attempt = 0; !stdout.includes("Background pricing update: updated.") && attempt < 200; attempt++) await delay(20);
      assert.match(stdout, /Background pricing update: updated\./);
      const waiting = await fetch(`${origin}/api/health`).then((response) => response.json() as Promise<DashboardHealth>);
      assert.equal(waiting.pricing?.updateAvailable, true);
      assert.ok(waiting.pricing?.fetchedAt);
      assert.equal((await fetch(`${origin}/api/analytics`).then((response) => response.json() as Promise<MachineAnalytics>)).generatedAt, initial.generatedAt);
      assert.doesNotMatch(JSON.stringify(waiting), new RegExp(privateSentinel));
    }
    let answered = false;
    const first = fetch(`${origin}/api/analytics?refresh=1`).then(async (response) => {
      assert.equal(response.status, 200); answered = true; return response.json() as Promise<MachineAnalytics>;
    });
    // Health remains available while pricing and the shared analysis flight are pending.
    await fetch(`${origin}/api/health`); assert.equal(answered, false);
    const second = fetch(`${origin}/api/analytics?refresh=1`).then((response) => response.json() as Promise<MachineAnalytics>);
    release(); const [refreshed, concurrent] = await Promise.all([first, second]);
    assert.equal(requests, 1); assert.equal(refreshed.generatedAt, concurrent.generatedAt);
    const priced = refreshed.sessions.flatMap((session) => session.models).find((model) => model.model === "claude-pricing-new");
    assert.ok(priced);
    assert.equal(priced.priced, true); assert.equal(priced.totalUsd, 3);
    const health = await fetch(`${origin}/api/health`).then((response) => response.json() as Promise<DashboardHealth>);
    assert.ok(health.pricing);
    assert.deepEqual(Object.keys(health.pricing).sort(), ["fetchedAt", "updateAvailable"]);
    assert.equal(health.pricing.updateAvailable, false); assert.ok(health.pricing.fetchedAt);
    assert.doesNotMatch(JSON.stringify([health, refreshed]), new RegExp(privateSentinel));
    if (maxAgeDays === 7) {
      await fetch(`${origin}/api/analytics?refresh=1`);
      assert.equal(requests, 1, "the new-model fetch is not repeated while fresh");
      return;
    }
    failed = true;
    const retained = await fetch(`${origin}/api/analytics?refresh=1`).then((response) => { assert.equal(response.status, 200); return response.json() as Promise<MachineAnalytics>; });
    assert.equal(retained.summary.estimatedSpendUsd, refreshed.summary.estimatedSpendUsd);
    assert.match(stdout, /Background pricing update: updated\./);
    assert.equal(stderr.split("Background pricing update unavailable; cached rates remain in use.").length - 1, 1);
    assert.doesNotMatch(stderr, new RegExp(privateSentinel));
  } finally {
    release(); child.kill("SIGTERM"); await once(child, "close");
    feed.closeAllConnections(); await new Promise<void>((done) => feed.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});
