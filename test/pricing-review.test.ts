import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { analyzeMachineSessions } from "../src/analyzer.ts";
import { catalogFromSnapshots, loadReviewed, pricingCoverage, resolveRate } from "../src/pricing/catalog.ts";
import { normalizeSource, sha256, SOURCE_URLS } from "../src/pricing/sources.ts";
import { pricingDirectory, readSnapshots, saveSnapshot } from "../src/pricing/store.ts";
import { validateRate } from "../src/pricing/validation.ts";
import type { MachineAnalytics, ModelUsage } from "../src/types.ts";
import { createSessionAnalyticsFixture, type SessionAnalyticsFixture } from "./fixtures.ts";
import { sourceSnapshot } from "./pricing-fixtures.ts";

async function temporary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "pricing-review-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

function environment(fixture: SessionAnalyticsFixture, directory: string): NodeJS.ProcessEnv {
  return { ...process.env, SESSION_ANALYTICS_NO_INDEX: "1", SESSION_ANALYTICS_ADDITIONAL_PROVIDERS: "0", NODE_NO_WARNINGS: "1", SESSION_ANALYTICS_OFFLINE: "1",
    SESSION_ANALYTICS_DATA_DIR: join(directory, "data"), SESSION_ANALYTICS_CLAUDE_ROOT: fixture.claudeRoot,
    SESSION_ANALYTICS_CODEX_ROOT: fixture.codexRoot, SESSION_ANALYTICS_CODEX_ARCHIVE_ROOT: fixture.codexArchiveRoot,
    SESSION_ANALYTICS_CONDUCTOR_DATABASE: fixture.databasePath, SESSION_ANALYTICS_CURSOR_DATABASE: fixture.cursorDatabasePath };
}

// Execute the actual renderer on the same serialized projection consumed by the browser.
class Element {
  textContent = "";
  children: Element[] = [];
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.children = nodes; }
  setAttribute() {}
  text(): string { return [this.textContent, ...this.children.map((node) => node.text())].join(" "); }
}
async function rendered(snapshot: MachineAnalytics): Promise<string> {
  const globals = globalThis as typeof globalThis & { document?: unknown };
  const previous = globals.document;
  globals.document = { createElement: () => new Element() };
  try {
    const { renderPricingPanel } = await import(new URL("../src/public/pricing.js", import.meta.url).href);
    const panel = new Element();
    renderPricingPanel(panel, snapshot.rateCard, snapshot.sessions);
    return panel.text();
  } finally { if (previous === undefined) delete globals.document; else globals.document = previous; }
}

async function apiSnapshot(env: NodeJS.ProcessEnv): Promise<MachineAnalytics> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address(); assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const child = spawn(process.execPath, ["src/server.ts", "--no-open", "--port", String(address.port)], { env });
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.resume();
  try {
    const deadline = Date.now() + 10000;
    while (!stdout.includes("Session Analytics ready:")) {
      assert.equal(child.exitCode, null); assert.ok(Date.now() < deadline, "server startup deadline");
      await delay(20);
    }
    const response = await fetch(`http://127.0.0.1:${address.port}/api/analytics`);
    assert.equal(response.status, 200);
    return await response.json() as MachineAnalytics;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
    }
  }
}

test("invalid provider models are redacted in report, status, API and Pricing view without losing tokens", async () => temporary(async (directory) => {
  const fixture = await createSessionAnalyticsFixture(directory);
  const cursor = new DatabaseSync(fixture.cursorDatabasePath);
  try {
    const row = cursor.prepare("SELECT value FROM cursorDiskKV WHERE key = ?").get("composerData:cursor-fixture")!;
    const composer = JSON.parse(String(row.value));
    composer.usageData = { "/PRIVATE_REVIEW_CURSOR_A": { costInCents: 123 }, "/PRIVATE_REVIEW_CURSOR_B": { costInCents: 50 } };
    cursor.prepare("UPDATE cursorDiskKV SET value = ? WHERE key = ?").run(JSON.stringify(composer), "composerData:cursor-fixture");
  } finally { cursor.close(); }
  const badModels: unknown[] = ["/PRIVATE_REVIEW_PATH/secret.txt", "relative/PRIVATE_REVIEW_PATH.json",
    "https://private.invalid/PRIVATE_REVIEW_URL", "C:\\PRIVATE_REVIEW_PATH\\secret.txt", "gpt-private\nCONTROL_SECRET",
    "66666666-7777-4888-8999-aaaaaaaaaaaa", "aabbccddeeff00112233445566778899", "session-PRIVATE_REVIEW_IDENTIFIER",
    "sk-proj-PRIVATE_REVIEW_CREDENTIAL", "AKIAXXXXXXXXXXXXXXXX", "ghp_PRIVATE_REVIEW_CREDENTIAL",
    "gpt-" + "x".repeat(200), ["gpt-PRIVATE_REVIEW_ARRAY"], { name: "PRIVATE_REVIEW_OBJECT" }, null];
  const models = [...badModels, "gpt-unmatched-fixture", "openai/gpt-5.4"];
  const claudeRoot = join(fixture.claudeRoot, "-review-models"); await mkdir(claudeRoot);
  for (const [index, model] of models.entries()) {
    const timestamp = `2026-07-22T10:00:${String(index).padStart(2, "0")}Z`;
    const id = `aaaa0000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    await writeFile(join(claudeRoot, `${id}.jsonl`), JSON.stringify({ type: "assistant", timestamp, sessionId: id,
      cwd: fixture.repositoryRoot, message: { id: `synthetic-response-${index}`, model,
        content: [{ type: "text", text: "PRIVATE_REVIEW_CONTENT" }], usage: { input_tokens: 100, output_tokens: 10 } } }) + "\n");
    const codexId = `bbbb0000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const usage = { input_tokens: 200 + index, output_tokens: 20, cached_input_tokens: 0 };
    await writeFile(join(fixture.codexRoot, `rollout-${codexId}.jsonl`), [
      { type: "session_meta", timestamp, payload: { id: codexId, cwd: fixture.repositoryRoot } },
      { type: "turn_context", timestamp, payload: { model } },
      { type: "event_msg", timestamp, payload: { type: "token_count", info: { last_token_usage: usage, total_token_usage: usage } } },
    ].map((value) => JSON.stringify(value)).join("\n") + "\n");
  }
  const env = environment(fixture, directory);
  const outputs: string[] = [];
  let snapshot: MachineAnalytics | undefined;
  for (const args of [["report", "--json"], ["report"], ["rates", "status", "--json"]]) {
    const result = spawnSync(process.execPath, ["bin/session-analytics.ts", ...args], { encoding: "utf8", env });
    assert.equal(result.status, 0, result.stderr);
    outputs.push(result.stdout, result.stderr);
    if (args[0] === "report" && args[1]) snapshot = JSON.parse(result.stdout) as MachineAnalytics;
  }
  const api = await apiSnapshot(env);
  outputs.push(JSON.stringify(api), await rendered(api));
  const catalog = catalogFromSnapshots(await loadReviewed(), [], { pricingPolicy: "reviewed-only" });
  outputs.push(JSON.stringify(pricingCoverage(catalog, badModels.filter((model): model is string => typeof model === "string"))));
  assert.ok(snapshot);
  // Also defend the renderer when handed an older, unprojected snapshot.
  const unsafe = structuredClone(snapshot);
  unsafe.sessions[0]!.models[0]!.model = "/PRIVATE_REVIEW_RENDER/secret.txt";
  outputs.push(await rendered(unsafe));
  for (const output of outputs) {
    assert.doesNotMatch(output, /PRIVATE_REVIEW|CONTROL_SECRET|66666666-7777-4888-8999-aaaaaaaaaaaa|aabbccddeeff00112233445566778899/);
    for (const model of badModels) if (typeof model === "string") assert.ok(!output.includes(model), "rejected model must not leave the projection");
  }
  for (const provider of ["claude", "codex"]) {
    const redacted: ModelUsage[] = snapshot.sessions.filter((session) => session.provider === provider)
      .flatMap((session) => session.models).filter((model) => model.model === "<unknown>");
    assert.equal(redacted.reduce((sum, model) => sum + model.calls, 0), badModels.length);
    assert.equal(redacted.reduce((sum, model) => sum + model.pricingCoverage!.eligibleTokens, 0),
      provider === "claude" ? badModels.length * 110 : badModels.reduce<number>((sum, _, index) => sum + 220 + index, 0));
    assert.ok(redacted.every((model) => !model.priced && model.pricingCoverage!.pricedTokens === 0));
  }
  assert.ok(snapshot.spendByModel.some((model) => model.model === "gpt-unmatched-fixture" && !model.priced));
  const cursorModels = snapshot.sessions.filter((session) => session.provider === "cursor").flatMap((session) => session.models);
  assert.equal(cursorModels.find((model) => model.model === "<unknown>")!.totalUsd, 1.73);
}));

test("report failures keep both streams content-free for missing cards, invalid cards and crashed workers", async () => temporary(async (directory) => {
  const fixture = await createSessionAnalyticsFixture(directory);
  const invalid = join(directory, "PRIVATE_REVIEW_INVALID.json");
  await writeFile(invalid, "PRIVATE_REVIEW_PARSE_ERROR");
  const loader = join(directory, "PRIVATE_REVIEW_WORKER.mjs");
  await writeFile(loader, `if (process.argv[1]?.endsWith('/analysis-worker.ts')) throw new Error('PRIVATE_REVIEW_WORKER_ERROR /private/sentinel.txt');\n`);
  const failures: string[] = [];
  for (const json of [false, true]) {
    for (const kind of ["missing", "invalid", "worker"]) {
      const args = ["bin/session-analytics.ts", "report", ...(json ? ["--json"] : []),
        ...(kind === "worker" ? [] : ["--rate-card", kind === "missing" ? join(directory, "PRIVATE_REVIEW_MISSING.json") : invalid])];
      const env = environment(fixture, directory);
      if (kind === "worker") env.NODE_OPTIONS = `--import=${loader}`;
      const result = spawnSync(process.execPath, args, { encoding: "utf8", env });
      assert.equal(result.status, 1); assert.equal(result.stdout, "");
      if (result.stderr !== "Session analysis could not be completed.\n") failures.push(`${kind}/${json}`);
      // Test all six cases even before the fix, without printing private error contents.
      if (/PRIVATE_REVIEW|file:|\bat .*\(|\/src\/|Error:/.test(result.stdout + result.stderr)) failures.push(`leak:${kind}/${json}`);
    }
  }
  assert.deepEqual(failures, []);
}));

test("cache-rate substitutions are estimates with partial coverage and visible request assumptions", async () => temporary(async (directory) => {
  const fixture = await createSessionAnalyticsFixture(directory);
  const dataDir = join(directory, "data");
  const payload = { anthropic: { models: { "claude-incomplete": { cost: { input: 3, output: 15 } } } } };
  await saveSnapshot(pricingDirectory({ dataDir }), { version: 1, source: "models.dev", sourceUrl: SOURCE_URLS["models.dev"],
    fetchedAt: "2026-01-01T00:00:00.000Z", payloadSha256: sha256(JSON.stringify(payload)), ...normalizeSource("models.dev", payload) });
  const root = join(fixture.claudeRoot, "-review-cache"); await mkdir(root);
  const id = "cccc0000-0000-4000-8000-000000000000";
  await writeFile(join(root, `${id}.jsonl`), JSON.stringify({ type: "assistant", timestamp: "2026-07-22T00:00:00Z",
    sessionId: id, cwd: fixture.repositoryRoot, message: { id: "one", model: "claude-incomplete", usage: {
      input_tokens: 1000000, output_tokens: 1000000, cache_read_input_tokens: 1000000, cache_creation_input_tokens: 1000000,
      cache_creation: { ephemeral_1h_input_tokens: 1000000, ephemeral_5m_input_tokens: 0 } } } }) + "\n");
  const snapshot = await analyzeMachineSessions({ ...fixture, dataDir, offline: true });
  const session = snapshot.sessions.find((session) => session.models.some((model) => model.model === "claude-incomplete"))!;
  assert.equal(session.cost.totalUsd, 24); // $3 input + $15 output + $3 estimated read + $3 estimated write.
  assert.deepEqual(session.models[0]!.pricingCoverage, { eligibleTokens: 4000000, pricedTokens: 2000000 });
  assert.equal(session.pricedTokenCoverage, 0.5); assert.equal(session.costComplete, false);
  assert.equal(session.models[0]!.priced, false);
  assert.deepEqual(session.models[0]!.pricing![0]!.assumptions, ["cache-read-at-input", "cache-write-1h-at-5m"]);
  assert.match(await rendered(snapshot), /Cache read: estimated at input rate/);
  assert.match(await rendered(snapshot), /1-hour cache write: estimated at 5-minute rate/);
  const reviewed = snapshot.sessions.filter((session) => session.provider === "codex").flatMap((session) => session.models);
  assert.ok(reviewed.some((model) => model.upperEstimateUsd > model.totalUsd &&
    model.pricing?.some((provenance) => provenance.assumptions.includes("codex-cache-write-upper-1.25x"))));
}));

test("history indexes do not rescan observations and share unchanged rates without losing evidence", async () => temporary(async (directory) => {
  const snapshots = Array.from({ length: 104 }, (_, index) => ({ ...sourceSnapshot(index % 2 ? "litellm" : "models.dev",
    new Date(Date.UTC(2026, 0, index + 1)).toISOString()), payloadSha256: sha256(`observation-${index}`) }));
  for (const snapshot of snapshots) await saveSnapshot(directory, snapshot);
  const loaded = await readSnapshots(directory);
  assert.equal(loaded.snapshots.length, snapshots.length); assert.deepEqual(loaded.warnings, []);
  const unique = new Set(loaded.snapshots.filter((snapshot) => snapshot.source !== "reviewed").map((snapshot) => snapshot.models));
  assert.equal(unique.size, 2, "unchanged rates share storage independently of payload hashes and observation dates");
  const catalog = catalogFromSnapshots(await loadReviewed(), loaded.snapshots, { pricingPolicy: "api-first" }, new Date("2027-01-01"));
  let reads = 0;
  catalog.history = new Proxy(catalog.history, { get(target, key, receiver) {
    if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
    return Reflect.get(target, key, receiver);
  } });
  for (const timestamp of ["2020-01-01", "2026-02-11", "2027-01-01"]) {
    for (let index = 0; index < 50; index += 1) {
      const selected = resolveRate(catalog, "openai/gpt-fixture", timestamp)!;
      assert.equal(selected.provenance.source, "models.dev");
      const expected = timestamp === "2020-01-01" ? snapshots[0]! : timestamp === "2026-02-11" ? snapshots[40]! : snapshots[102]!;
      assert.equal(selected.provenance.snapshotDate, expected.fetchedAt);
      assert.equal(selected.provenance.payloadSha256, expected.payloadSha256);
    }
  }
  assert.equal(reads, 0, "request lookup uses the prebuilt index, including pre-first-observation requests");
}));

test("reviewed rate provider validation rejects arrays, objects and null", () => {
  const rate = { inputPerMillion: 1, outputPerMillion: 2, source: "https://example.com/prices" };
  for (const provider of [["claude"], ["codex"], { toString: () => "claude" }, {}, null, 0, true]) {
    assert.throws(() => validateRate({ ...rate, provider }), "provider must be an enum string");
  }
  for (const provider of ["claude", "codex"]) assert.equal(validateRate({ ...rate, provider }).provider, provider);
});

test("legacy observations and shared rate blobs preserve changes, provenance, and corruption isolation", async () => temporary(async (directory) => {
  const legacy = sourceSnapshot("models.dev", "2026-01-01T00:00:00.000Z", 2);
  const checksum = sha256(JSON.stringify(legacy));
  await writeFile(join(directory, `models.dev-2026-01-01T000000000-${checksum}.json`), JSON.stringify({ checksum, snapshot: legacy }));
  const unchanged = { ...sourceSnapshot("models.dev", "2026-02-01T00:00:00.000Z", 2), payloadSha256: sha256("changed non-price public feed fields") };
  const changed = sourceSnapshot("models.dev", "2026-03-01T00:00:00.000Z", 4);
  await saveSnapshot(directory, unchanged); await saveSnapshot(directory, changed);
  const loaded = await readSnapshots(directory);
  assert.equal(loaded.snapshots.length, 3); assert.deepEqual(loaded.warnings, []);
  const tables = loaded.snapshots.map((snapshot) => snapshot.source === "reviewed" ? snapshot.card.models : snapshot.models);
  assert.equal(tables[0], tables[1]); assert.notEqual(tables[1], tables[2]);
  const catalog = catalogFromSnapshots(await loadReviewed(), loaded.snapshots, {}, new Date("2027-01-01"));
  for (const snapshot of [legacy, unchanged, changed]) {
    const selected = resolveRate(catalog, "openai/gpt-fixture", snapshot.fetchedAt)!;
    assert.equal(selected.provenance.payloadSha256, snapshot.payloadSha256);
    assert.equal(selected.rate.inputPerMillion, snapshot.models["gpt-fixture"]!.inputPerMillion);
  }
  const observationName = (await readdir(directory)).find((name) => name.startsWith("models.dev-2026-02"))!;
  const descriptor = JSON.parse(await readFile(join(directory, observationName), "utf8"));
  await writeFile(join(directory, `rates-${descriptor.snapshot.modelsSha256}.json`), "PRIVATE_CORRUPT_RATE_TABLE");
  const damaged = await readSnapshots(directory);
  assert.equal(damaged.snapshots.length, 2); assert.deepEqual(damaged.warnings, ["invalid-snapshot"]);
  assert.equal(damaged.snapshots.at(-1)!.payloadSha256, changed.payloadSha256);
  assert.doesNotMatch(JSON.stringify(damaged), /PRIVATE_CORRUPT/);
  await assert.rejects(saveSnapshot(directory, unchanged), /damaged/);
}));

test("legacy context-cache assumptions remain conservative when the old format cannot identify their tier", async () => temporary(async (directory) => {
  const legacy = sourceSnapshot("models.dev", "2026-01-01T00:00:00.000Z");
  const rate = legacy.models["claude-fixture-4-5"]!;
  rate.contextTiers = [{ aboveInputTokens: 200000, inputPerMillion: 6, outputPerMillion: 22.5, cacheWrite1hPerMillion: 12 }];
  const checksum = sha256(JSON.stringify(legacy));
  await writeFile(join(directory, `models.dev-2026-01-01T000000000-${checksum}.json`), JSON.stringify({ checksum, snapshot: legacy }));
  const loaded = (await readSnapshots(directory)).snapshots[0]!;
  assert.ok(loaded.source !== "reviewed");
  assert.deepEqual(loaded.models["claude-fixture-4-5"]!.contextTiers![0]!.assumptions, ["anthropic-cache-1h-2x"]);
}));

test("updates can reuse an existing legacy reviewed archive without changing its envelope", async () => temporary(async (directory) => {
  const snapshot = await loadReviewed();
  const checksum = sha256(JSON.stringify(snapshot));
  const name = `reviewed-${snapshot.fetchedAt.replace(/[:.Z]/g, "")}-${checksum}.json`;
  const payload = JSON.stringify({ checksum, snapshot }) + "\n";
  await writeFile(join(directory, name), payload);
  await saveSnapshot(directory, snapshot);
  assert.equal(await readFile(join(directory, name), "utf8"), payload);
  assert.equal((await readSnapshots(directory)).snapshots.length, 1);
  const versionedPayload = JSON.stringify({ storageVersion: 1, checksum, snapshot }) + "\n";
  await writeFile(join(directory, name), versionedPayload);
  await saveSnapshot(directory, snapshot);
  assert.equal(await readFile(join(directory, name), "utf8"), versionedPayload);
}));

test("Claude aggregate cache writes retain unobserved TTLs through parsing, JSON and the Pricing view", async () => temporary(async (directory) => {
  const fixture = await createSessionAnalyticsFixture(directory);
  const id = "dddd0000-0000-4000-8000-000000000000";
  const root = join(fixture.claudeRoot, "-review-ttl"); await mkdir(root);
  await writeFile(join(root, `${id}.jsonl`), JSON.stringify({ type: "assistant", timestamp: "2026-07-23T00:00:00Z",
    sessionId: id, cwd: fixture.repositoryRoot, message: { id: "one", model: "claude-opus-5", usage: {
      input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 100 } } }) + "\n");
  const snapshot = await analyzeMachineSessions({ ...fixture, pricingPolicy: "reviewed-only", offline: true });
  const session = snapshot.sessions.find((session) => session.firstEventAt === "2026-07-23T00:00:00.000Z")!;
  assert.equal(session.tokens.inputTokens, 200); assert.equal(session.tokens.cacheWrite5mInputTokens, 0);
  assert.equal(session.costComplete, false); assert.equal(session.pricedTokenCoverage, 0.5);
  assert.deepEqual(session.models[0]!.pricing![0]!.assumptions, ["cache-write-ttl-5m"]);
  assert.match(JSON.stringify(snapshot), /cache-write-ttl-5m/);
  assert.match(await rendered(snapshot), /Cache-write TTL unavailable: estimated as 5 minutes/);
}));
