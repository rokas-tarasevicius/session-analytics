import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDashboardPricing } from "../src/pricing/dashboard.ts";
import { loadPricingCatalog, resolveRate } from "../src/pricing/catalog.ts";
import { pricingDirectory, saveSnapshot } from "../src/pricing/store.ts";
import { devPayload, privateSentinel, sourceSnapshot } from "./pricing-fixtures.ts";

const DAY = 86400000;
async function fixture(run: (context: {
  dataDir: string; urls: { "models.dev": string }; now: () => Date; advance: (ms: number) => void;
  requests: () => number; fail: () => void; change: () => void;
}) => Promise<void>) {
  const dataDir = await mkdtemp(join(tmpdir(), "dashboard-pricing-"));
  let time = Date.parse("2026-10-20T12:00:00.000Z"), requests = 0, failed = false, input = 2;
  const server = createServer((request, response) => {
    requests++;
    assert.equal(request.method, "GET"); assert.equal(request.url, "/prices");
    response.end(failed ? privateSentinel : JSON.stringify(devPayload(input)));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  try {
    await run({ dataDir, urls: { "models.dev": `http://127.0.0.1:${address.port}/prices` }, now: () => new Date(time),
      advance: (ms) => { time += ms; }, requests: () => requests, fail: () => { failed = true; }, change: () => { input = 4; } });
  } finally {
    server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("manual pricing refresh awaits a single flight and reads the updated cache before a scan", async () => fixture(async (f) => {
  const coordinator = createDashboardPricing({ dataDir: f.dataDir, pricingSources: ["models.dev"] }, { ...f, log: () => {} });
  await Promise.all([coordinator.check(), coordinator.check(), coordinator.check()]);
  assert.equal(f.requests(), 1);
  const catalog = await loadPricingCatalog({ dataDir: f.dataDir }, f.now());
  assert.equal(resolveRate(catalog, "gpt-fixture")?.rate.inputPerMillion, 2);
  assert.deepEqual(coordinator.status(), { updateAvailable: true, fetchedAt: f.now().toISOString() });
  coordinator.applied(coordinator.revision());
  assert.equal(coordinator.status().updateAvailable, false);
  await coordinator.check(); assert.equal(f.requests(), 1);
}));

test("six-hour scheduler detects changed tables, preserves pending updates across concurrent scans, and stops", async () => fixture(async (f) => {
  let tick: (() => void) | undefined, cancelled = false;
  const coordinator = createDashboardPricing({ dataDir: f.dataDir, pricingSources: ["models.dev"], pricingMaxAgeDays: 1 }, {
    ...f, log: () => {}, schedule: (callback, milliseconds) => {
      assert.equal(milliseconds, 6 * 3600000); tick = callback; return () => { cancelled = true; };
    },
  });
  coordinator.start(); assert.ok(tick);
  await coordinator.check(); const scanRevision = coordinator.revision(); coordinator.applied(scanRevision);
  f.advance(2 * DAY); f.change(); tick();
  await coordinator.check();
  assert.equal(f.requests(), 2);
  coordinator.applied(scanRevision);
  assert.equal(coordinator.status().updateAvailable, true, "an old scan must not consume a newer update");
  coordinator.applied(coordinator.revision());
  f.advance(2 * DAY); await coordinator.check();
  assert.equal(coordinator.status().updateAvailable, false, "identical normalized prices need no new snapshot");
  coordinator.stop(); assert.equal(cancelled, true);
}));

test("unmatched observed models check a fresh-by-policy source after 24h, once per day even on failure", async () => fixture(async (f) => {
  const options = { dataDir: f.dataDir, pricingSources: ["models.dev" as const] };
  await saveSnapshot(pricingDirectory(options), sourceSnapshot("models.dev", new Date(f.now().valueOf() - 2 * DAY).toISOString()));
  const errors: string[] = [];
  const coordinator = createDashboardPricing(options, { ...f, log: () => {}, error: (line) => errors.push(line) });
  await coordinator.check("unpriced", ["gpt-fixture", "gpt-fixture"]); assert.equal(f.requests(), 0);
  await coordinator.check("unpriced", [privateSentinel, "<unknown>"]); assert.equal(f.requests(), 0);
  f.fail();
  await Promise.all([coordinator.check(), coordinator.check("unpriced", ["gpt-new"]), coordinator.check("unpriced", ["gpt-new"])]);
  assert.equal(f.requests(), 1); assert.equal(errors.length, 1);
  assert.equal(errors[0], "Background pricing update unavailable; cached rates remain in use.");
  await coordinator.check("unpriced", ["gpt-another-new"]); assert.equal(f.requests(), 1);
  f.advance(DAY); await coordinator.check("unpriced", ["gpt-new"]); assert.equal(f.requests(), 2);
  assert.doesNotMatch(JSON.stringify([coordinator.status(), errors]), new RegExp(privateSentinel));
}));

test("unmatched models wait for the source's 24h boundary; offline and pinned dashboards never schedule or fetch", async () => fixture(async (f) => {
  const options = { dataDir: f.dataDir, pricingSources: ["models.dev" as const] };
  await saveSnapshot(pricingDirectory(options), sourceSnapshot("models.dev", f.now().toISOString()));
  const coordinator = createDashboardPricing(options, { ...f, log: () => {} });
  f.advance(DAY); await coordinator.check("unpriced", ["gpt-new"]); assert.equal(f.requests(), 0);
  f.advance(1); await coordinator.check("unpriced", ["gpt-new"]); assert.equal(f.requests(), 1);
  for (const [settings, snapshot] of [[{ offline: true }, false], [{ pricingPolicy: "reviewed-only" as const }, false],
    [{ rateCardPath: "/private/sentinel-card" }, false], [{}, true]] as const) {
    const disabled = createDashboardPricing({ ...options, ...settings }, { ...f, snapshot,
      schedule: () => { assert.fail("disabled pricing must not schedule"); } });
    disabled.start(); await disabled.check(); await disabled.check("unpriced", ["gpt-new"]); disabled.stop();
    assert.equal(disabled.enabled, false);
  }
  assert.equal(f.requests(), 1);
}));

test("manual update failure retains the cache and resolves normally with one fixed stderr line", async () => fixture(async (f) => {
  const options = { dataDir: f.dataDir, pricingSources: ["models.dev" as const], pricingMaxAgeDays: 0 };
  await saveSnapshot(pricingDirectory(options), sourceSnapshot("models.dev", new Date(f.now().valueOf() - DAY).toISOString()));
  f.fail(); const errors: string[] = [];
  const coordinator = createDashboardPricing(options, { ...f, log: () => {}, error: (line) => errors.push(line) });
  await coordinator.check(); assert.equal(errors.length, 1);
  assert.equal(resolveRate(await loadPricingCatalog(options, f.now()), "gpt-fixture")?.rate.inputPerMillion, 2);
  assert.equal(coordinator.status().updateAvailable, false);
  assert.doesNotMatch(JSON.stringify(errors), new RegExp(privateSentinel));
}));
