import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findModelRate } from "../src/pricing/aliases.ts";
import { catalogFromSnapshots, latestDiff, loadPricingCatalog, loadReviewed, pricingCoverage, publicRateCard,
  rateForContext, resolveRate } from "../src/pricing/catalog.ts";
import { fetchSource, normalizeSource, sha256, SOURCE_URLS } from "../src/pricing/sources.ts";
import { pricingDirectory, readSnapshots, saveSnapshot, type ReviewedSnapshot } from "../src/pricing/store.ts";
import { updatePricing, refreshPricingIfStale } from "../src/pricing/update.ts";
import { validateRate } from "../src/pricing/validation.ts";
import { analyzeOptionsFrom } from "../src/options.ts";
import type { ModelRate } from "../src/types.ts";
import { devPayload, litePayload, privateSentinel, sourceSnapshot } from "./pricing-fixtures.ts";

const JAN = "2026-01-01T00:00:00.000Z", FEB = "2026-02-01T00:00:00.000Z", MAR = "2026-03-01T00:00:00.000Z";
const now = new Date("2026-03-03T00:00:00.000Z");
const rate = (input: number): ModelRate => ({ provider: "codex", inputPerMillion: input, outputPerMillion: 10,
  source: "https://example.com/public-prices" });
const reviewed = (input = 9, date = JAN): ReviewedSnapshot => ({ version: 1, source: "reviewed", fetchedAt: date,
  payloadSha256: sha256(String(input) + date), card: { currency: "USD", effectiveDate: date.slice(0, 10),
    reviewedOverrides: [], models: { "gpt-fixture": rate(input), "gpt-fallback": rate(1) } } });

async function temporary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "pricing-test-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

async function httpFixture(handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (origin: string) => Promise<void>): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

test("normalizes live-shaped feeds, units, cache TTLs, context tiers and explicit assumptions", () => {
  const dev = normalizeSource("models.dev", devPayload()), lite = normalizeSource("litellm", litePayload());
  assert.equal(Object.keys(dev.models).length, 2); assert.equal(Object.keys(lite.models).length, 2);
  assert.equal(dev.models["gpt-fixture"]?.inputPerMillion, 2);
  assert.equal(lite.models["gpt-fixture"]?.inputPerMillion, 4);
  assert.equal(dev.models["claude-fixture-4-5"]?.cacheWrite1hPerMillion, 6);
  assert.deepEqual(dev.models["claude-fixture-4-5"]?.assumptions, ["anthropic-cache-1h-2x"]);
  assert.equal(lite.models["claude-fixture-4-5"]?.cacheWrite1hPerMillion, 6);
  assert.equal(lite.models["claude-fixture-4-5"]?.assumptions, undefined);
  const base = dev.models["gpt-fixture"]!;
  assert.equal(rateForContext(base, 272000).inputPerMillion, 2);
  assert.equal(rateForContext(base, 272001).inputPerMillion, 4);
  assert.equal(rateForContext(base, 272001).cacheReadPerMillion, 0.3);
  const claudeLong = rateForContext(lite.models["claude-fixture-4-5"]!, 200001);
  assert.equal(claudeLong.cacheWrite1hPerMillion, 12);
  assert.equal(claudeLong.cacheWrite5mPerMillion, 7.5);
  assert.doesNotMatch(JSON.stringify([dev, lite]), new RegExp(privateSentinel));
  assert.doesNotMatch(JSON.stringify([dev, lite]), /reseller|azure|image-fixture/);
});

test("rejects absurd, negative, nonfinite and corrupt rates instead of coercing them to zero", () => {
  for (const bad of [-1, Infinity, NaN, "2", null, 10001]) assert.throws(() => validateRate({ ...rate(1), inputPerMillion: bad }));
  assert.equal(validateRate(rate(0)).inputPerMillion, 0);
  assert.throws(() => normalizeSource("models.dev", {}));
  assert.throws(() => normalizeSource("litellm", { "gpt-invalid": { litellm_provider: "openai", input_cost_per_token: 3, output_cost_per_token: 1 } }));
  const payload = devPayload();
  Object.assign(payload.openai.models, { "gpt-bad": { cost: { input: -1, output: 10 } } });
  assert.equal(normalizeSource("models.dev", payload).rejectedModels, 1);
  assert.throws(() => validateRate({ ...rate(1), contextTiers: [{ aboveInputTokens: 1.5, inputPerMillion: 1, outputPerMillion: 2 }] }));
  assert.throws(() => validateRate({ ...rate(1), source: "https://user:secret@example.com/" }));
});

test("aliases dates, lab prefixes and numeric punctuation, preserves exact IDs and refuses ambiguity", () => {
  const models = { "claude-fixture-4-5": { ...rate(3), provider: "claude" as const }, "gpt-5.4": rate(2) };
  for (const id of ["anthropic/claude-fixture-4.5", "claude-fixture-4-5-20260101", "claude-fixture-4-5-2026-01-01"]) {
    assert.equal(findModelRate(models, id)?.rate.inputPerMillion, 3);
  }
  assert.equal(findModelRate(models, "openai/gpt-5-4-2026-02-01")?.rate.inputPerMillion, 2);
  assert.equal(findModelRate(models, "bedrock/claude-fixture-4-5"), undefined);
  assert.equal(findModelRate(models, "openai/claude-fixture-4-5"), undefined);
  assert.equal(findModelRate(models, "gpt-5.4-mini"), undefined);
  assert.equal(findModelRate(models, "__proto__"), undefined);
  assert.equal(findModelRate({ "gpt-5.4-20260101": rate(1), "gpt-5.4-20260201": rate(2) }, "gpt-5.4"), undefined);
  assert.equal(findModelRate({ ...models, "gpt-5.4-20260101": rate(1) }, "gpt-5.4-20260101")?.rate.inputPerMillion, 1);
});

test("merges reviewed exceptions, ordered APIs and fallbacks with configurable precedence", () => {
  const card = reviewed(); card.card.reviewedOverrides = ["gpt-fixture"];
  const history = [sourceSnapshot("models.dev", FEB), sourceSnapshot("litellm", FEB)];
  assert.equal(resolveRate(catalogFromSnapshots(card, history, {}, now), "gpt-fixture")?.rate.inputPerMillion, 9);
  const api = catalogFromSnapshots(card, history, { pricingPolicy: "api-first" }, now);
  assert.equal(resolveRate(api, "gpt-fixture")?.rate.inputPerMillion, 2);
  assert.equal(resolveRate(api, "gpt-fallback")?.provenance.kind, "fallback");
  const reverse = catalogFromSnapshots(card, history, { pricingPolicy: "api-first", pricingSources: ["litellm", "models.dev"] }, now);
  assert.equal(resolveRate(reverse, "gpt-fixture")?.rate.inputPerMillion, 4);
  const only = catalogFromSnapshots(card, history, { pricingPolicy: "reviewed-only" }, now);
  assert.equal(resolveRate(only, "claude-fixture-4-5"), undefined);
  assert.equal(only.status.stale, false);
});

test("selects immutable request-time history, labels oldest and missing-time fallback, retains reviewed history", () => {
  const history = [sourceSnapshot("models.dev", JAN, 1), sourceSnapshot("models.dev", FEB, 2), sourceSnapshot("models.dev", MAR, 3)];
  const catalog = catalogFromSnapshots(reviewed(), history, {}, now);
  for (const [at, input] of [["2026-01-25T12:00:00Z", 1], [FEB, 2], ["2026-02-28T23:59:59.999Z", 2], [MAR, 3]] as const) {
    assert.equal(resolveRate(catalog, "gpt-fixture", at)?.rate.inputPerMillion, input);
  }
  assert.equal(resolveRate(catalog, "gpt-fixture", "2025-01-01")?.provenance.temporal, "oldest");
  assert.equal(resolveRate(catalog, "gpt-fixture", null)?.provenance.temporal, "undated");
  assert.equal(resolveRate(catalog, "gpt-fixture", "invalid")?.rate.inputPerMillion, 3);
  const old = reviewed(5), current = reviewed(8, FEB);
  old.card.reviewedOverrides = current.card.reviewedOverrides = ["gpt-fixture"];
  const pinned = catalogFromSnapshots(current, [old, ...history], {}, now);
  assert.equal(resolveRate(pinned, "gpt-fixture", JAN)?.rate.inputPerMillion, 5);
  assert.equal(resolveRate(pinned, "gpt-fixture", MAR)?.rate.inputPerMillion, 8);
  assert.equal(resolveRate(catalog, "gpt-missing", JAN), undefined);
  const introduced = catalogFromSnapshots(reviewed(), [sourceSnapshot("litellm", JAN, 1), sourceSnapshot("models.dev", FEB, 8)], {}, now);
  assert.equal(resolveRate(introduced, "gpt-fixture", "2026-01-15")?.rate.inputPerMillion, 1);
  assert.equal(resolveRate(introduced, "gpt-fixture", FEB)?.rate.inputPerMillion, 8);
});

test("snapshot store is atomic, immutable, checksummed and tolerant of damaged files", async () => temporary(async (directory) => {
  const snapshot = sourceSnapshot("models.dev", JAN);
  await Promise.all([saveSnapshot(directory, snapshot), saveSnapshot(directory, snapshot)]);
  assert.equal((await readdir(directory)).length, 2); // One immutable observation and one shared rate table.
  const loaded = await readSnapshots(directory);
  assert.equal(loaded.snapshots.length, 1); assert.deepEqual(loaded.warnings, []);
  const name = (await readdir(directory)).find((name) => name.startsWith("rates-"))!;
  await writeFile(join(directory, name), (await readFile(join(directory, name), "utf8")).replace('"inputPerMillion":2', '"inputPerMillion":999'));
  const corrupt = await readSnapshots(directory);
  assert.equal(corrupt.snapshots.length, 0); assert.deepEqual(corrupt.warnings, ["invalid-snapshot"]);
  assert.doesNotMatch(JSON.stringify(corrupt), new RegExp(directory));
}));

test("public fetches are fixed GETs with no local data in URL, headers or body", async () => {
  const requests: unknown[] = [];
  await httpFixture((request, response) => {
    let body = ""; request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => { requests.push({ method: request.method, url: request.url, headers: request.headers, body });
      response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(request.url === "/dev.json" ? devPayload() : litePayload())); });
  }, async (origin) => {
    for (const [source, path] of [["models.dev", "/dev.json"], ["litellm", "/lite.json"]] as const) {
      const fetched = await fetchSource(source, { fixtureUrl: origin + path, now: new Date(JAN) });
      assert.equal(fetched.sourceUrl, SOURCE_URLS[source]);
      assert.equal(fetched.fetchedAt, JAN); assert.match(fetched.payloadSha256, /^[a-f0-9]{64}$/);
      assert.doesNotMatch(JSON.stringify(fetched), new RegExp(privateSentinel));
    }
    await assert.rejects(fetchSource("models.dev", { fixtureUrl: origin + "/?local=secret" }));
  });
  assert.equal(requests.length, 2);
  for (const raw of requests) {
    const request = raw as { method: string; url: string; body: string; headers: Record<string, string> };
    assert.equal(request.method, "GET"); assert.equal(request.body, "");
    assert.ok(["/dev.json", "/lite.json"].includes(request.url));
    assert.equal(request.headers.authorization, undefined); assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers.referer, undefined);
    assert.doesNotMatch(JSON.stringify(request), /secret|gpt-|claude-|repository|session|pricing-test/);
  }
});

test("offline flag and environment prevent every source request, including background refresh", async () => temporary(async (dataDir) => {
  let requests = 0;
  await httpFixture((_request, response) => { requests += 1; response.end(JSON.stringify(devPayload())); }, async (origin) => {
    await assert.rejects(fetchSource("models.dev", { fixtureUrl: origin + "/", offline: true }), /offline/);
    const options = { dataDir, offline: true };
    assert.equal((await updatePricing(options, { urls: { "models.dev": origin + "/" } })).status, "offline");
    assert.equal(await refreshPricingIfStale(options), null);
    const before = process.env.SESSION_ANALYTICS_OFFLINE;
    process.env.SESSION_ANALYTICS_OFFLINE = "1";
    try { await assert.rejects(fetchSource("models.dev", { fixtureUrl: origin + "/" }), /offline/); }
    finally { if (before === undefined) delete process.env.SESSION_ANALYTICS_OFFLINE; else process.env.SESSION_ANALYTICS_OFFLINE = before; }
  });
  assert.equal(requests, 0);
  assert.equal((await readdir(dataDir)).length, 0);
}));

test("background refresh checks every source, skips a fresh cache and updates a stale one", async () => temporary(async (dataDir) => {
  let requests = 0;
  await httpFixture((_request, response) => { requests += 1; response.end(JSON.stringify(devPayload())); }, async (origin) => {
    const options = { dataDir, pricingSources: ["models.dev" as const] };
    const fixtures = { urls: { "models.dev": origin + "/prices" } };
    assert.equal((await refreshPricingIfStale(options, fixtures))?.status, "updated");
    assert.equal(await refreshPricingIfStale(options, fixtures), null);
    assert.equal(requests, 1);
    assert.equal((await refreshPricingIfStale({ ...options, pricingMaxAgeDays: 0 }, fixtures))?.status, "updated");
    assert.equal(requests, 2);
  });
}));

test("a pinned custom card bypasses cached APIs and rejects malformed entries without exposing their content", async () => temporary(async (dataDir) => {
  const path = join(dataDir, "reviewed.json");
  await writeFile(path, JSON.stringify(reviewed().card));
  await saveSnapshot(pricingDirectory({ dataDir }), sourceSnapshot("models.dev", JAN));
  const options = { dataDir, rateCardPath: path };
  const catalog = await loadPricingCatalog(options);
  assert.equal(catalog.status.policy, "reviewed-only"); assert.equal(catalog.status.snapshots, 0);
  assert.equal(resolveRate(catalog, "gpt-fixture")?.rate.inputPerMillion, 9);
  assert.equal((await updatePricing(options)).status, "reviewed-only");
  assert.equal(await refreshPricingIfStale(options), null);
  await writeFile(path, JSON.stringify({ ...reviewed().card, models: { [privateSentinel]: null } }));
  await assert.rejects(loadPricingCatalog(options), { message: "The configured rate card is invalid or unavailable." });
}));

test("updates retain valid snapshots when a source fails, and diff flags large changes", async () => temporary(async (dataDir) => {
  let currentInput = 2, bad = false;
  await httpFixture((request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(request.url === "/dev" ? bad ? "corrupt-private-error" : JSON.stringify(devPayload(currentInput)) : JSON.stringify(litePayload()));
  }, async (origin) => {
    const urls = { "models.dev": origin + "/dev", litellm: origin + "/lite" };
    assert.equal((await updatePricing({ dataDir }, { urls, now: new Date(JAN) })).status, "updated");
    currentInput = 8;
    const updated = await updatePricing({ dataDir }, { urls, now: new Date(FEB) });
    assert.equal(updated.status, "updated"); assert.ok(updated.changes.some(({ model, large }) => model === "gpt-fixture" && large));
    let catalog = await loadPricingCatalog({ dataDir });
    assert.ok(latestDiff(catalog).some(({ large }) => large));
    assert.ok(catalog.status.warnings.includes("large-price-change"));
    bad = true;
    const failed = await updatePricing({ dataDir }, { urls, now: new Date(MAR) });
    assert.equal(failed.status, "partial");
    catalog = await loadPricingCatalog({ dataDir });
    assert.equal(catalog.status.sources.find(({ source }) => source === "models.dev")?.fetchedAt, FEB);
    assert.equal(resolveRate(catalog, "gpt-fixture", "2026-01-20")?.rate.inputPerMillion, 2);
    assert.doesNotMatch(JSON.stringify([catalog.status, failed]), /corrupt-private-error|pricing-test-/);
  });
}));

test("transport rejects redirects, HTTP failures, invalid JSON, timeouts and unbounded bodies", async () => {
  let redirected = false;
  await httpFixture((request, response) => {
    if (request.url === "/redirect") { response.writeHead(302, { Location: "/target" }); response.end(); }
    else if (request.url === "/target") { redirected = true; response.end(JSON.stringify(devPayload())); }
    else if (request.url === "/error") { response.writeHead(500); response.end(privateSentinel); }
    else if (request.url === "/timeout") { /* aborted by client deadline */ }
    else if (request.url === "/large") { response.end(" ".repeat(33 * 1024 * 1024)); }
    else response.end("not-json");
  }, async (origin) => {
    for (const path of ["redirect", "error", "timeout", "large", "invalid"]) {
      await assert.rejects(fetchSource("models.dev", { fixtureUrl: `${origin}/${path}`, timeoutMs: path === "timeout" ? 20 : 3000 }));
    }
  });
  assert.equal(redirected, false);
});

test("status includes age per source, guarded coverage and sanitized provenance", () => {
  const catalog = catalogFromSnapshots(reviewed(), [sourceSnapshot("models.dev", MAR)], {}, now);
  assert.equal(catalog.status.sources[0]?.ageDays, 2); assert.equal(catalog.status.sources[0]?.stale, false);
  assert.equal(catalog.status.sources[1]?.stale, true); assert.equal(catalog.status.stale, true);
  const empty = pricingCoverage(catalog, []); assert.equal(empty.ratio, null);
  const coverage = pricingCoverage(catalog, ["gpt-fixture", "openai/gpt-fixture", "gpt-missing", "gpt-fixture"]);
  assert.equal(coverage.modelsSeen, 3); assert.equal(coverage.modelsPriced, 2);
  const publicCard = publicRateCard(catalog);
  assert.equal(publicCard.models.find(({ model }) => model === "gpt-fixture")?.provenance?.source, "models.dev");
  assert.doesNotMatch(JSON.stringify(publicCard), new RegExp(privateSentinel));
});

test("platform data directories and configuration precedence are explicit", () => {
  assert.equal(pricingDirectory({}, {}, "darwin", "/example"), "/example/Library/Application Support/session-analytics/pricing");
  assert.equal(pricingDirectory({}, { XDG_DATA_HOME: "/data" }, "linux", "/example"), "/data/session-analytics/pricing");
  assert.equal(pricingDirectory({}, { XDG_DATA_HOME: "relative" }, "linux", "/example"), "/example/.local/share/session-analytics/pricing");
  const options = analyzeOptionsFrom(["--offline", "--pricing-max-age-days", "3", "--pricing-sources", "litellm,models.dev"],
    { SESSION_ANALYTICS_PRICING_MAX_AGE_DAYS: "10", SESSION_ANALYTICS_DATA_DIR: "/override" });
  assert.equal(options.pricingMaxAgeDays, 3); assert.equal(options.offline, true); assert.equal(pricingDirectory(options), "/override/pricing");
  for (const args of [["--pricing-sources", "unknown"], ["--pricing-sources", "litellm,litellm"], ["--pricing-policy", "other"], ["--pricing-max-age-days", "-1"]]) {
    assert.throws(() => analyzeOptionsFrom(args, {}));
  }
});

test("reviewed exceptions retain cache ratios and context modifiers without inventing a Spark tariff", async () => {
  const card = await loadReviewed();
  const catalog = catalogFromSnapshots(card, [], {}, new Date("2026-10-03"));
  for (const [model, ratio] of [["claude-opus-5-5", 0.05], ["claude-fable-5-1", 0.025]] as const) {
    const result = resolveRate(catalog, model)!;
    assert.equal(result.provenance.kind, "reviewed"); assert.equal(result.rate.cacheReadPerMillion! / result.rate.inputPerMillion, ratio);
  }
  assert.equal(resolveRate(catalog, "gpt-5.3-codex-spark"), undefined);
  assert.deepEqual(resolveRate(catalog, "gpt-6.1-sol")?.rate.longContext,
    { inputMultiplier: 2, outputMultiplier: 1.5, thresholdInputTokens: 272000 });
});

test("rates CLI supports JSON, offline updates, aliases, diff and fixed errors", async () => temporary(async (directory) => {
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath,
    ["bin/session-analytics.ts", "rates", ...args], { encoding: "utf8", env: { ...process.env, SESSION_ANALYTICS_DATA_DIR: directory, SESSION_ANALYTICS_OFFLINE: "1", ...env } });
  const help = run(["--help"]); assert.equal(help.status, 0); assert.match(help.stdout, /update\|show/);
  const update = run(["update", "--offline", "--json"]); assert.equal(update.status, 0); assert.equal(JSON.parse(update.stdout).status, "offline");
  const show = run(["show", "anthropic/claude-opus-5.5", "--json"]); assert.equal(show.status, 0, show.stderr);
  assert.equal(JSON.parse(show.stdout).models[0].provenance.kind, "reviewed");
  const diff = run(["diff", "--json"]); assert.equal(diff.status, 0); assert.deepEqual(JSON.parse(diff.stdout).changes, []);
  assert.equal(run(["show", "missing-model", "--json"]).status, 1);
  assert.equal(run(["update", "--bad-secret"]).status, 2);
  const invalid = run(["show", "--rate-card", "/secret-path/not-present"]);
  assert.equal(invalid.status, 1); assert.doesNotMatch(invalid.stderr, /secret-path|Error:|file:/);
}));
