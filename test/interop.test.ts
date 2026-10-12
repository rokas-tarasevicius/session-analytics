import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { analyzeMachineSessions } from "../src/analyzer.ts";
import type { MachineAnalytics } from "../src/types.ts";
import { snapshotSchemas } from "../scripts/snapshot-schema.ts";
import { exportFiles } from "../src/interop/exports.ts";
import { loadMachineSnapshot, loadSnapshot, validateSnapshot } from "../src/interop/snapshot.ts";
import { loadShareKey, mergeSharedSnapshots, readAliases, shareSnapshot, validateSharedSnapshot } from "../src/interop/sharing.ts";
import { matchesSchema, snapshotSchema, sharedSchema } from "../src/interop/schema.ts";
import { writeNewFiles, readJsonFile } from "../src/interop/files.ts";
import { otlpEndpoint, otlpLogs, postOtlp, semanticConventionsCommit } from "../src/interop/otlp.ts";
import { csv, csvTables, filterSnapshot } from "../src/public/export-data.js";
import { buildToolsView } from "../src/public/tools-data.js";
import { createSessionAnalyticsFixture } from "./fixtures.ts";

const run = promisify(execFile);
const secret = Buffer.alloc(32, 1);
const bin = new URL("../bin/session-analytics.ts", import.meta.url).pathname;
const sentinels = /secret-command|secret-path|secret-skill-args|content-is-not-returned|11111111-1111-4111-8111-111111111111|22222222-2222-4222-8222-222222222222|https:\/\/github.com\/example\/conductor.git|\/fixtures\/workspaces/;
let directory: string;
let snapshot: MachineAnalytics;
let input: string;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "interop-fixture-"));
  const fixture = await createSessionAnalyticsFixture(directory);
  const { repositoryRoot, remote, ...options } = fixture;
  snapshot = await analyzeMachineSessions(options);
  input = join(directory, "snapshot.json");
  await writeFile(input, JSON.stringify(snapshot));
});
after(async () => { await rm(directory, { recursive: true, force: true }); });

function cohort(size = 5): MachineAnalytics {
  const session = snapshot.sessions.find((s) => s.provider === "claude")!;
  const sessions = Array.from({ length: size }, (_, i) => ({ ...structuredClone(session), sessionKey: createHash("sha256").update(`synthetic-${i}`).digest("hex").slice(0, 12) }));
  // A synthetic cohort has no corresponding machine-wide statistics cache.
  const { historyCoverage, ...source } = snapshot;
  return filterSnapshot({ ...source, sessions });
}

// Decode actual RFC 4180 quoting, including embedded CRLF and escaped double quotes.
function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], value = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '"') { if (quoted && text[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && char === ",") { row.push(value); value = ""; }
    else if (!quoted && char === "\r" && text[i + 1] === "\n") { row.push(value); rows.push(row); row = []; value = ""; i++; }
    else value += char;
  }
  assert.equal(quoted, false); return rows;
}

test("v1 schema validates real-shape fixtures and has no drift from checked field maps", async () => {
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(matchesSchema(snapshot, snapshotSchema), true);
  assert.deepEqual(validateSnapshot(snapshot), snapshot);
  for (const [name, schema] of Object.entries(snapshotSchemas())) assert.deepEqual(JSON.parse(await readFile(new URL(`../schemas/${name}`, import.meta.url), "utf8")), schema);
  const mutations = [
    (s: any) => { s.schemaVersion = 2; },
    (s: any) => { s.prompt = "content-is-not-returned"; },
    (s: any) => { s.sessions[0].tools = { secret: "content-is-not-returned" }; },
    (s: any) => { s.sessions[0].tokens.inputTokens = -1; },
    (s: any) => { delete s.sessions[0].cost; },
    (s: any) => { s.sessions[0].provider = "synthetic-future-agent"; },
    (s: any) => { s.rateCard.models[0].source = "javascript:alert(1)"; },
    (s: any) => { s.sessions[0].pricedTokenCoverage = 2; },
    (s: any) => { s.sessions[0].createdAt = "invalid"; },
    (s: any) => { s.sessions.push(s.sessions[0]); },
    (s: any) => { s.sessions[0].repositoryName = "mismatch"; },
    (s: any) => { s.summary.sessions++; },
    (s: any) => { s.repositories[0].summary.estimatedSpendUsd++; },
    (s: any) => { s.sessions[0].models.push(s.sessions[0].models[0]); },
    (s: any) => { s.sessions[0].tools = JSON.parse('{"__proto__":1}'); },
  ];
  for (const mutate of mutations) { const value = structuredClone(snapshot); mutate(value); assert.throws(() => validateSnapshot(value)); }
});

test("all interchange surfaces keep fixture content, raw IDs and paths out", () => {
  for (const format of ["csv", "ndjson", "otlp-json"] as const) {
    for (const content of Object.values(exportFiles(snapshot, format))) assert.doesNotMatch(content, sentinels);
  }
  const shared = shareSnapshot(cohort(), secret);
  assert.doesNotMatch(JSON.stringify(shared), sentinels);
  for (const session of snapshot.sessions) {
    assert.ok(!JSON.stringify(shared).includes(session.sessionKey));
    assert.ok(!JSON.stringify(shared).includes(session.repositoryId));
    assert.ok(!JSON.stringify(shared).includes(session.repositoryName));
    assert.ok(!JSON.stringify(shared).includes(session.createdAt));
  }
  assert.equal(matchesSchema(shared, sharedSchema), true);
});

test("CSV preserves quoted cells, null coverage, numeric sums and provider cost basis", () => {
  const special = 'comma, quote" and\r\nline';
  assert.deepEqual(parseCsv(csv([{ name: special, value: null }, { name: "=SUM(1,2)", value: 0 }, { name: " \t@formula", value: 3 }], ["name", "value"])), [["name", "value"], [special, ""], ["'=SUM(1,2)", "0"], ["' \t@formula", "3"]]);
  const files = csvTables(snapshot);
  assert.deepEqual(Object.keys(files).sort(), ["daily.csv", "models.csv", "sessions.csv", "tools.csv"]);
  const rows = parseCsv(files["sessions.csv"]!); const columns = rows.shift()!;
  assert.equal(rows.length, snapshot.sessions.length);
  assert.equal(rows.reduce((sum, row) => sum + Number(row[columns.indexOf("inputTokens")]), 0), snapshot.summary.totalInputTokens);
  const cursor = rows.find((row) => row[columns.indexOf("provider")] === "cursor")!;
  assert.equal(cursor[columns.indexOf("pricedTokenCoverage")], "");
  assert.equal(cursor[columns.indexOf("costBasis")], "provider-reported");
  assert.ok(parseCsv(files["daily.csv"]!).slice(1).every((row) => row[3] !== "cursor"));
  for (const content of Object.values(csvTables(filterSnapshot(snapshot, { providers: [] })))) assert.equal(parseCsv(content).length, 1);
});

test("tools.csv applies the Tools eligibility rule", () => {
  const source = snapshot.sessions.find((s) => s.provider === "claude")!;
  const observed = structuredClone(source);
  observed.tools = { Read: 8, NotFinite: NaN, Infinite: Infinity, Negative: -2, Zero: 0 };
  observed.evidence = { source: "conductor-messages", fidelity: "message", tokens: "reported", tools: "observed", turns: "observed", timing: "provider", usageUnit: "request" };
  const invalid = structuredClone(source);
  invalid.tools = { Invalid: 1000, Read: 1000 }; invalid.transcript.status = "invalid";
  const unavailable = structuredClone(source);
  unavailable.tools = { Missing: 1000, Read: 1000 }; unavailable.evidence = { ...observed.evidence, tools: "unavailable" };
  const legacy = structuredClone(source);
  legacy.tools = { Read: 2 }; delete legacy.evidence;
  const sessions = [observed, invalid, unavailable, legacy];
  const filtered = filterSnapshot({ ...snapshot, sessions });
  const content = csvTables(filtered)["tools.csv"]!;
  const rows = parseCsv(content); const columns = rows.shift()!;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]![columns.indexOf("tool")], "Read");
  assert.equal(rows[0]![columns.indexOf("contributingSessions")], "2");
  assert.equal(rows[0]![columns.indexOf("calls")], "10");
  assert.doesNotMatch(content, /Invalid|Missing|NotFinite|Infinite|Negative|Zero|NaN|Infinity/);
  const tools = buildToolsView(sessions).tools.map(({ name, calls }) => ({ name, value: calls }));
  assert.deepEqual(filtered.topTools, tools);
  assert.deepEqual(filtered.repositories.find((r) => r.repository.id === source.repositoryId)!.topTools, tools);
});

test("NDJSON frames every row with schemaVersion and reconstructs the snapshot evidence", () => {
  const records = exportFiles(snapshot, "ndjson")["snapshot.ndjson"]!.trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(records.every((row) => row.schemaVersion === 1));
  assert.equal(records[0].kind, "snapshot");
  assert.deepEqual(records[0].summary, snapshot.summary);
  assert.deepEqual(records.filter((r) => r.kind === "session").map(({ kind, schemaVersion, ...r }) => r), snapshot.sessions);
  assert.equal(records.filter((r) => r.kind === "repository").length, snapshot.repositories.length);
});

test("filtered JSON recomputes every rollup and preserves zero and N/A semantics", () => {
  const original = JSON.stringify(snapshot);
  const source = snapshot.sessions.find((s) => s.provider === "claude")!;
  const filtered = filterSnapshot(snapshot, { providers: ["claude"], repositoryId: source.repositoryId, start: source.createdAt, end: new Date(Date.parse(source.createdAt) + 1).toISOString() });
  assert.equal(filtered.sessions.length, 1);
  assert.equal(filtered.summary.estimatedSpendUsd, source.cost.totalUsd);
  assert.equal(filtered.repositories[0]!.summary.toolCalls, source.metrics.toolCalls);
  assert.equal(filtered.summary.repositories, 1);
  assert.equal(matchesSchema(filtered, snapshotSchema), true);
  assert.equal(JSON.stringify(snapshot), original);
  const empty = filterSnapshot(snapshot, { providers: [] });
  assert.equal(empty.summary.sessions, 0); assert.equal(empty.summary.pricedTokenCoverage, null); assert.equal(empty.spendByModel.length, 0);
  assert.equal(filterSnapshot(snapshot, { repositoryIds: [] }).repositories.length, 0);
});

test("sharing threshold suppresses rows and all reconstruction totals below k", () => {
  const suppressed = shareSnapshot(cohort(4), secret);
  assert.deepEqual(suppressed.repositories, []); assert.deepEqual(suppressed.sources, []);
  assert.ok(Object.values(suppressed.summary).every((n) => n === 0));
  const eligible = shareSnapshot(cohort(5), secret);
  assert.equal(eligible.repositories.length, 1); assert.equal(eligible.summary.sessions, 5);
  assert.equal(eligible.summary.inputTokens, cohort(5).summary.totalInputTokens);
  assert.equal(shareSnapshot(cohort(6), secret).summary.sessions, 6);
  assert.throws(() => shareSnapshot(cohort(), secret, 1));
  const duplicate = cohort(); duplicate.sessions[1]!.sessionKey = duplicate.sessions[0]!.sessionKey;
  assert.throws(() => shareSnapshot(duplicate, secret));
  const invalid = cohort(); invalid.sessions[0]!.transcript.status = "invalid";
  assert.equal(shareSnapshot(invalid, secret).repositories.length, 0);
  const mixed = cohort();
  const other = mixed.repositories.find((r) => r.repository.id !== mixed.sessions[0]!.repositoryId)!;
  const extra = structuredClone(mixed.sessions[0]!);
  extra.repositoryId = other.repository.id; extra.repositoryName = other.repository.name;
  extra.sessionKey = "abcdef123456"; extra.tokens.inputTokens = 9_876_543;
  mixed.sessions.push(extra);
  assert.deepEqual(shareSnapshot(mixed, secret), eligible, "suppressed evidence cannot be reconstructed from any field, including totals");
});

test("pseudonyms are keyed, stable and domain-separated; aliases are explicit", () => {
  const data = cohort(); const first = shareSnapshot(data, secret);
  assert.deepEqual(first, shareSnapshot(data, secret));
  const second = shareSnapshot(data, Buffer.alloc(32, 2));
  assert.notEqual(first.repositories[0]!.repository, second.repositories[0]!.repository);
  assert.notEqual(first.sources[0], second.sources[0]);
  assert.notEqual(first.sources[0]!.slice(7), first.repositories[0]!.repository.slice(5));
  const alias = shareSnapshot(data, secret, 5, { [data.sessions[0]!.repositoryId]: "project-alpha" });
  assert.equal(alias.repositories[0]!.repository, "alias-project-alpha");
  assert.throws(() => shareSnapshot(data, secret, 5, { unknown: "project-alpha" }));
});

test("merge combines only disjoint sources, matching aliases and compatible thresholds", () => {
  const data = cohort(); const aliases = { [data.sessions[0]!.repositoryId]: "project-alpha" };
  const one = shareSnapshot(data, secret, 5, aliases), two = shareSnapshot(data, Buffer.alloc(32, 2), 5, aliases);
  const merged = mergeSharedSnapshots([one, two]);
  assert.equal(merged.repositories.length, 1); assert.equal(merged.summary.sessions, 10);
  assert.equal(merged.summary.apiEquivalentSpendUsd, one.summary.apiEquivalentSpendUsd * 2);
  assert.deepEqual(merged, mergeSharedSnapshots([two, one]));
  assert.throws(() => mergeSharedSnapshots([one, one]), /Repeated/);
  assert.throws(() => mergeSharedSnapshots([merged, one]), /Repeated/);
  assert.throws(() => mergeSharedSnapshots([one, shareSnapshot(data, secret, 2)]), /same minimum/);
  assert.throws(() => mergeSharedSnapshots([snapshot]));
  assert.throws(() => mergeSharedSnapshots([]));
  for (const mutate of [(s: any) => { s.sessions = []; }, (s: any) => { s.summary.sessions++; }, (s: any) => { s.repositories[0].sessions = 1; }, (s: any) => { s.repositories[0].prompt = "content-is-not-returned"; }, (s: any) => { s.repositories.push(s.repositories[0]); }]) {
    const bad = structuredClone(one); mutate(bad); assert.throws(() => validateSharedSnapshot(bad));
  }
});

test("sharing key is created privately, reused, and symlinks are rejected", async () => {
  const path = join(directory, "keys", "share.key");
  const first = await loadShareKey(path), second = await loadShareKey(path);
  assert.equal(first.length, 32); assert.deepEqual(first, second); assert.equal((await stat(path)).mode & 0o777, 0o600);
  const linked = join(directory, "linked.key"); await symlink(path, linked); await assert.rejects(loadShareKey(linked));
  const aliases = join(directory, "aliases.json"); await writeFile(aliases, JSON.stringify({ [snapshot.repositories[0]!.repository.id]: "project-alpha" }));
  assert.equal(Object.values(await readAliases(aliases))[0], "project-alpha");
  await writeFile(aliases, '{"id":"/private/path"}'); await assert.rejects(readAliases(aliases));
});

test("snapshot IO validates versions, rejects unknown fields, bounds input, and does not follow symlinks", async () => {
  assert.deepEqual(await loadMachineSnapshot(input), snapshot);
  const sharedPath = join(directory, "shared.json"); await writeFile(sharedPath, JSON.stringify(shareSnapshot(cohort(), secret)));
  assert.equal("kind" in await loadSnapshot(sharedPath), true); await assert.rejects(loadMachineSnapshot(sharedPath));
  await assert.rejects(readJsonFile(input, 20));
  const link = join(directory, "snapshot-link.json"); await symlink(input, link); await assert.rejects(loadSnapshot(link));
  const bad = join(directory, "content-is-not-returned.json"); await writeFile(bad, '{"secret-path": "secret-command"}');
  await assert.rejects(loadSnapshot(bad), (error: unknown) => { assert.doesNotMatch(String(error), sentinels); return true; });
});

test("snapshots from earlier versions load with their removed analysis fields ignored", async () => {
  const legacy = structuredClone(snapshot) as MachineAnalytics & Record<string, unknown>;
  Object.assign(legacy, { limitsCache: { profiles: [] }, outcomes: { sessions: 1 }, workflow: { schemaVersion: 1 } });
  Object.assign(legacy.repositories[0]!, { outcomes: { sessions: 1 } });
  for (const session of legacy.sessions) {
    Object.assign(session, { reliability: { version: 1 }, limitsCache: { buckets: [] }, outcomes: { editsObserved: false },
      workflow: { schemaVersion: 1 }, insightSignals: {}, skills: { review: 1 }, skillEvidence: "explicit" });
    if (session.mcpEvidence) Object.assign(session.mcpEvidence, { toolOutcomes: [], rateLimits: [], truncated: false });
  }
  const path = join(directory, "legacy-snapshot.json"); await writeFile(path, JSON.stringify(legacy));
  assert.deepEqual(await loadMachineSnapshot(path), snapshot);
  // Only the listed legacy fields are ignored; any other unknown field is still rejected.
  const unknown = structuredClone(snapshot) as MachineAnalytics & Record<string, unknown>;
  Object.assign(unknown.sessions[0]!, { rawContent: "content-is-not-returned" });
  const unknownPath = join(directory, "unknown-field.json"); await writeFile(unknownPath, JSON.stringify(unknown));
  await assert.rejects(loadMachineSnapshot(unknownPath));
});

test("export files are private, never overwrite earlier files, and roll back partial batches", async () => {
  const output = join(directory, "out");
  await writeNewFiles(output, { "tools.csv": "original" });
  await assert.rejects(writeNewFiles(output, { "sessions.csv": "new", "tools.csv": "overwritten" }));
  assert.equal(await readFile(join(output, "tools.csv"), "utf8"), "original");
  await assert.rejects(stat(join(output, "sessions.csv")));
  assert.equal((await stat(join(output, "tools.csv"))).mode & 0o777, 0o600);
});

test("OTLP logs use valid integer encodings and avoid fabricated spans and model attribution", () => {
  const value = otlpLogs(snapshot) as any;
  const scope = value.resourceLogs[0].scopeLogs[0];
  assert.equal(scope.schemaUrl, "https://opentelemetry.io/schemas/1.37.0");
  assert.match(semanticConventionsCommit, /^[a-f0-9]{40}$/);
  assert.equal(scope.logRecords.length, snapshot.sessions.length);
  let inputTokens = 0;
  for (const record of scope.logRecords) {
    assert.match(record.timeUnixNano, /^\d+$/); assert.equal(record.timeUnixNano, String(BigInt(Date.parse(snapshot.generatedAt)) * 1000000n));
    const attributes = Object.fromEntries(record.attributes.map((a: any) => [a.key, a.value]));
    assert.equal(attributes["gen_ai.operation.name"], undefined); assert.equal(attributes["gen_ai.provider.name"], undefined);
    inputTokens += Number(attributes["gen_ai.usage.input_tokens"].intValue);
    if (attributes["session_analytics.provider"].stringValue === "cursor") assert.equal(attributes["gen_ai.response.model"], undefined);
  }
  assert.equal(inputTokens, snapshot.summary.totalInputTokens);
  for (const endpoint of ["file:///secret", "http://example.test/v1/logs", "https://name:secret@example.test/v1/logs", "https://example.test/#secret"]) assert.throws(() => otlpEndpoint(endpoint));
});

test("OTLP delivery posts the saved bytes only on opt-in and refuses redirects and partial success", async () => {
  const received: string[] = []; let responseCode = 200, responseBody = "{}";
  const collector = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    assert.equal(request.method, "POST"); assert.equal(request.headers["content-type"], "application/json");
    received.push(body); response.writeHead(responseCode, { "Content-Type": "application/json", Location: "/redirect" }); response.end(responseBody);
  });
  await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
  try {
    const address = collector.address(); assert.ok(address && typeof address === "object");
    const endpoint = `http://127.0.0.1:${address.port}/v1/logs`;
    const output = join(directory, "otlp-cli");
    await run(process.execPath, [bin, "export", "--snapshot", input, "--format", "otlp-json", "--out", output, "--otlp-endpoint", endpoint]);
    assert.equal(received.length, 1); assert.equal(received[0], await readFile(join(output, "otlp-logs.json"), "utf8"));
    const invalid = structuredClone(snapshot);
    const oldId = invalid.repositories[0]!.repository.id;
    invalid.repositories[0]!.repository.id = "11111111-2222-4333-8444-555555555555";
    for (const session of invalid.sessions) if (session.repositoryId === oldId) session.repositoryId = invalid.repositories[0]!.repository.id;
    const invalidPath = join(directory, "collector-invalid.json"); await writeFile(invalidPath, JSON.stringify(invalid));
    await assert.rejects(run(process.execPath, [bin, "export", "--snapshot", invalidPath, "--format", "otlp-json", "--out", join(directory, "invalid-out"), "--otlp-endpoint", endpoint]));
    assert.equal(received.length, 1, "invalid imports never reach the collector");
    responseBody = JSON.stringify({ partialSuccess: { rejectedLogRecords: "1", errorMessage: "secret-path" } });
    await assert.rejects(postOtlp(otlpEndpoint(endpoint), received[0]!), /not fully acknowledged/);
    responseCode = 307; await assert.rejects(postOtlp(otlpEndpoint(endpoint), received[0]!)); assert.equal(received.length, 3);
    responseCode = 200; responseBody = "content-is-not-returned";
    await assert.rejects(postOtlp(otlpEndpoint(endpoint), received[0]!), (error) => { assert.doesNotMatch(String(error), sentinels); return true; });
    responseBody = " ".repeat(65 * 1024); await assert.rejects(postOtlp(otlpEndpoint(endpoint), received[0]!));
    responseBody = "secret-command"; responseCode = 503;
    await assert.rejects(postOtlp(otlpEndpoint(endpoint), received[0]!), /not fully acknowledged/);
  } finally { await new Promise<void>((resolve, reject) => collector.close((error) => error ? reject(error) : resolve())); }
});

test("CLI preview, export, merge and snapshot report stay offline and use fixed errors", async () => {
  const cohortPath = join(directory, "cohort.json"); await writeFile(cohortPath, JSON.stringify(cohort()));
  const result = await run(process.execPath, [bin, "report", "--share", "--snapshot", cohortPath, "--share-key-file", join(directory, "cli.key")]);
  assert.match(result.stderr, /stdout is the entire aggregate payload/);
  const shared = JSON.parse(result.stdout); validateSharedSnapshot(shared);
  assert.doesNotMatch(result.stdout, sentinels);
  const sharedPath = join(directory, "cli-shared.json"); await writeFile(sharedPath, result.stdout);
  const merged = await run(process.execPath, [bin, "merge", sharedPath]); assert.deepEqual(JSON.parse(merged.stdout), shared);
  const regular = await run(process.execPath, [bin, "report", "--json", "--snapshot", input]); assert.deepEqual(JSON.parse(regular.stdout), snapshot);
  const output = join(directory, "cli-csv"); await run(process.execPath, [bin, "export", "--snapshot", input, "--format", "csv", "--out", output]);
  assert.equal(await readFile(join(output, "sessions.csv"), "utf8"), csvTables(snapshot)["sessions.csv"]);
  for (const args of [["export", "--format", "bad", "--out", output], ["export", "--format", "csv", "--out", output, "--otlp-endpoint", "https://example.test/"], ["report", "--share", "--min-sessions", "1"], ["report", "--snapshot", input, "--claude-root", "secret-path"], ["merge", input], ["merge", sharedPath, sharedPath], ["report", "--snapshot", "secret-path", "--json"]]) {
    const invalid = spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" });
    assert.notEqual(invalid.status, 0); assert.equal(invalid.stdout, ""); assert.doesNotMatch(invalid.stderr, sentinels);
  }
});

test("large sharing previews drain stdout completely when piped", async () => {
  const base = cohort(2);
  const source = base.sessions[0]!;
  const repositories = Array.from({ length: 250 }, (_, i) => ({
    ...base.repositories[0]!, repository: { id: `discovered-${i.toString(16).padStart(20, "0")}`, name: `synthetic-project-${i}` },
  }));
  const sessions = repositories.flatMap(({ repository }, i) => [0, 1].map((j) => ({
    ...source, repositoryId: repository.id, repositoryName: repository.name,
    sessionKey: createHash("sha256").update(`large-synthetic-${i}-${j}`).digest("hex").slice(0, 12),
  })));
  const large = filterSnapshot({ ...base, repositories, sessions });
  const path = join(directory, "large-snapshot.json"); await writeFile(path, JSON.stringify(large));
  const result = await run(process.execPath, [bin, "report", "--share", "--snapshot", path, "--min-sessions", "2", "--share-key-file", join(directory, "large.key")]);
  assert.ok(result.stdout.length > 65_536);
  const shared = validateSharedSnapshot(JSON.parse(result.stdout));
  assert.equal(shared.repositories.length, 250); assert.equal(shared.summary.sessions, 500);
});

test("non-regular snapshot and key files fail without blocking on a FIFO", { skip: process.platform === "win32" }, async () => {
  const path = join(directory, "input.fifo"); await run("mkfifo", [path]);
  const script = `
    import { readJsonFile } from './src/interop/files.ts';
    import { loadShareKey } from './src/interop/sharing.ts';
    for (const read of [readJsonFile, loadShareKey]) {
      try { await read(process.argv[1]); process.exitCode = 1; }
      catch { process.stdout.write('rejected\\n'); }
    }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, path], { encoding: "utf8", timeout: 2000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, "rejected\nrejected\n");
});

test("review: typed private strings cannot cross the import/export boundary", async () => {
  const mutations: Array<(s: MachineAnalytics) => void> = [
    (s) => { const old = s.sessions[0]!.repositoryId; const id = "11111111-2222-4333-8444-555555555555"; s.repositories.find((r) => r.repository.id === old)!.repository.id = id; for (const row of s.sessions) if (row.repositoryId === old) row.repositoryId = id; },
    (s) => { s.warnings = ["EACCES /private/secret-path"]; },
    (s) => { s.repositories[0]!.warnings = ["EACCES /private/secret-path"]; },
    (s) => { s.sessions[0]!.transcript.warnings = ["EACCES /private/secret-path"]; },
    (s) => { Object.assign(s.sessions[0]!, { status: "secret-command --token=secret" }); },
    (s) => { s.sessions[0]!.models[0]!.model = "/private/secret-path"; },
    (s) => { s.sessions[0]!.tools = { "secret-command --token=secret": s.sessions[0]!.metrics.toolCalls }; },
    (s) => { s.sessions[0]!.transportTools = { "/private/secret-path": s.sessions[0]!.metrics.transportToolCalls }; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const bad = structuredClone(snapshot); mutate(bad);
    const path = join(directory, `private-${index}.json`); await writeFile(path, JSON.stringify(bad));
    await assert.rejects(loadSnapshot(path), /Snapshot file is invalid/);
    for (const format of ["csv", "ndjson", "otlp-json"] as const) assert.throws(() => exportFiles(bad, format), /Snapshot is invalid/);
    const report = spawnSync(process.execPath, [bin, "report", "--snapshot", path, "--json"], { encoding: "utf8" });
    assert.notEqual(report.status, 0); assert.equal(report.stdout, ""); assert.doesNotMatch(report.stderr, /secret|11111111-2222/);
  }
});

test("review: date selection compares instants and uses an exclusive next-day bound", () => {
  for (const createdAt of ["2026-07-20 14:00:00", "2026-07-21T00:30:00+02:00", "2026-07-20T23:59:59Z", "2026-07-20T23:59:59.999999Z", "2026-07-20T00:00:00Z", "2026-07-19T20:00:00-04:00"]) {
    const source = cohort(1); source.sessions[0]!.createdAt = createdAt;
    validateSnapshot(source);
    const result = filterSnapshot(source, { start: "2026-07-20T00:00:00.000Z", end: "2026-07-21T00:00:00.000Z" });
    assert.equal(result.summary.sessions, 1, createdAt);
    assert.equal(result.summary.totalInputTokens, source.summary.totalInputTokens);
  }
  const source = cohort(1); source.sessions[0]!.createdAt = "2026-07-21T00:00:00Z";
  assert.equal(filterSnapshot(source, { end: "2026-07-21T00:00:00.000Z" }).sessions.length, 0);
});

test("review: unsupported Conductor agents and database timestamps round-trip safely", async () => {
  const root = await mkdtemp(join(directory, "unsupported-"));
  const fixture = await createSessionAnalyticsFixture(root);
  const database = new DatabaseSync(fixture.databasePath);
  try {
    database.exec("UPDATE sessions SET agent_type = 'synthetic-future-agent', status = 'secret-command --token=secret', created_at = '2026-07-20 14:00:00', updated_at = '2026-07-20 15:00:00' WHERE agent_type = 'claude'");
  } finally { database.close(); }
  const { repositoryRoot, remote, ...options } = fixture;
  const result = await analyzeMachineSessions(options);
  const unsupported = result.sessions.find((s) => s.transcript.status === "unsupported")!;
  assert.equal(unsupported.provider, "unsupported");
  assert.equal(unsupported.status, "unknown");
  assert.equal(unsupported.createdAt, "2026-07-20T14:00:00.000Z");
  assert.equal(unsupported.costBasis, "unavailable");
  assert.doesNotMatch(JSON.stringify(result), /synthetic-future-agent|secret-command/);
  validateSnapshot(result);
  const path = join(root, "snapshot.json"); await writeFile(path, JSON.stringify(result));
  assert.deepEqual(await loadMachineSnapshot(path), result);
  for (const format of ["csv", "ndjson", "otlp-json"] as const) assert.ok(Object.keys(exportFiles(result, format)).length);
  assert.equal(shareSnapshot(result, secret, 2).summary.sessions, result.summary.analyzedSessions);
});

test("review: contradictory rollups and session breakdowns are rejected across formats", () => {
  const mutations: Array<(s: MachineAnalytics) => void> = [
    (s) => { s.spendByDay = [{ name: "2026-07-20", value: 999999 }]; s.repositories[0]!.spendByDay = s.spendByDay; },
    (s) => { s.spendByModel[0]!.totalUsd++; },
    (s) => { s.repositories[0]!.topTools[0]!.value++; },
    (s) => { s.topTools.push(s.topTools[0]!); },
    (s) => { s.sessions.find((r) => r.provider === "claude")!.models[0]!.inputTokens += 100000; },
    (s) => { s.sessions[0]!.tokens.inputTokens += 0.5; },
    (s) => { s.sessions[0]!.tokens.nonReasoningOutputTokens++; },
    (s) => { s.sessions[0]!.costByExecution.unknownUsd++; },
    (s) => { s.sessions[0]!.spendByDay["2026-07-20"] = 999999; },
    (s) => { s.sessions[0]!.metrics.toolCalls++; },
    (s) => { s.sessions[0]!.pricedTokenCoverage = 0.5; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const bad = structuredClone(snapshot); mutate(bad);
    for (const format of ["csv", "ndjson", "otlp-json"] as const) assert.throws(() => exportFiles(bad, format), /Snapshot is invalid/, `mutation ${index}, ${format}`);
  }
  const cursor = filterSnapshot(snapshot, { providers: ["cursor"] });
  assert.ok(cursor.sessions.some((s) => s.tokens.inputTokens > 0 && s.models.every((m) => m.inputTokens === 0)));
  validateSnapshot(cursor);
});

test("review: filtered snapshots retain scan-wide caveats and regenerate selection warnings", () => {
  const source = structuredClone(snapshot), warning = "A provider transcript root could not be read.";
  source.warnings.push(warning); source.repositories[0]!.warnings.push(warning);
  for (const providers of [null, ["cursor"], []]) {
    const filtered = filterSnapshot(source, { providers });
    assert.ok(filtered.warnings.includes(warning));
    assert.ok(filtered.repositories[0]!.warnings.includes(warning));
    assert.ok(filtered.warnings.some((w) => w.startsWith("Filtered export:")));
    validateSnapshot(filtered);
    assert.equal(filterSnapshot(filtered).warnings.filter((w) => w === warning).length, 1);
  }
  const missing = structuredClone(source.sessions[0]!);
  missing.transcript.status = "missing";
  missing.transcript.warnings = ["Conductor has no provider session ID."];
  const withMissing = filterSnapshot({ ...source, sessions: [missing] });
  assert.ok(withMissing.warnings.some((w) => w.startsWith("1 legacy session")));
  assert.ok(!filterSnapshot(withMissing, { providers: [] }).warnings.some((w) => w.startsWith("1 legacy session")));
});

test("review: shared active and malformed evidence stays thresholded without small-group disclosure", async () => {
  const root = await mkdtemp(join(directory, "partial-"));
  const { repositoryRoot, remote, ...options } = await createSessionAnalyticsFixture(root);
  const database = new DatabaseSync(options.databasePath);
  try { database.exec("UPDATE sessions SET status = 'working' WHERE agent_type = 'claude'"); } finally { database.close(); }
  const path = join(options.claudeRoot, "-fixtures-workspaces-conductor-claude-workspace", "22222222-2222-4222-8222-222222222222.jsonl");
  await writeFile(path, `${await readFile(path, "utf8")}broken secret-content\n{\ntruncated secret-content\n`);
  const parsed = await analyzeMachineSessions(options);
  const session = parsed.sessions.find((s) => s.provider === "claude")!;
  assert.equal(session.transcript.snapshotWhileWorking, true);
  assert.ok(session.transcript.warnings.includes("3 malformed JSONL records were skipped in the primary transcript."));
  const active = cohort(5);
  active.sessions = active.sessions.map((s) => ({ ...structuredClone(session), sessionKey: s.sessionKey }));
  const shared = shareSnapshot(active, secret);
  assert.equal(shared.summary.sessions, 5);
  assert.equal(shared.summary.pricedTokens, shared.summary.priceableTokens);
  assert.doesNotMatch(JSON.stringify(shared), /working|malformed|secret-content|partial/);
  assert.equal(shareSnapshot({ ...active, sessions: active.sessions.slice(1) }, secret).summary.sessions, 0);
});

test("review: Claude cache-write totals include the recorded disjoint TTL counts", async () => {
  const root = await mkdtemp(join(directory, "cache-shape-"));
  const { repositoryRoot, remote, ...options } = await createSessionAnalyticsFixture(root);
  const path = join(options.claudeRoot, "-fixtures-workspaces-conductor-claude-workspace", "22222222-2222-4222-8222-222222222222.jsonl");
  const records = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  for (const record of records) if (record.message?.usage?.cache_creation) record.message.usage.cache_creation_input_tokens = 100;
  await writeFile(path, records.map((record) => JSON.stringify(record)).join("\n"));
  const result = await analyzeMachineSessions(options);
  const claude = result.sessions.find((session) => session.provider === "claude")!;
  assert.equal(claude.tokens.cacheWriteInputTokens, 200);
  assert.equal(claude.tokens.inputTokens, 750);
  assert.ok(claude.transcript.warnings.includes("Cache-write totals were reconciled from the recorded TTL breakdown."));
  validateSnapshot(result);
});

test("review: malformed provider model/tool labels are replaced before any public output", async () => {
  const root = await mkdtemp(join(directory, "metadata-"));
  const { repositoryRoot, remote, ...options } = await createSessionAnalyticsFixture(root);
  const path = join(options.claudeRoot, "-fixtures-workspaces-conductor-claude-workspace", "22222222-2222-4222-8222-222222222222.jsonl");
  const records = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  for (const record of records) if (record.type === "assistant") {
    record.message.model = "/private/secret-path";
    record.message.content[0].name = "secret-command --token=secret";
  }
  await writeFile(path, records.map((record) => JSON.stringify(record)).join("\n"));
  const result = await analyzeMachineSessions(options);
  validateSnapshot(result);
  const session = result.sessions.find((s) => s.provider === "claude")!;
  assert.equal(session.tools.unknown_tool, 1);
  assert.equal(session.metrics.toolCalls, 3);
  assert.ok(session.models.some((model) => model.model === "<unknown>" && !model.priced));
  assert.doesNotMatch(JSON.stringify(result), /secret-path|secret-command/);
  for (const format of ["csv", "ndjson", "otlp-json"] as const) for (const content of Object.values(exportFiles(result, format))) assert.doesNotMatch(content, /secret-path|secret-command/);
});

test("integration: every metric namespace and pricing provenance survives filtered exports", () => {
  const filtered = filterSnapshot(snapshot, { providers: ["claude"] });
  validateSnapshot(filtered);
  assert.equal(filtered.sessions.length, 1);
  assert.deepEqual(filtered.velocity, snapshot.velocity);
  assert.ok(filtered.spendByModel.some((m) => m.pricing?.length && m.pricingCoverage));
  const metadata = JSON.parse(exportFiles(filtered, "ndjson")["snapshot.ndjson"]!.split("\n")[0]!);
  for (const key of ["velocity", "mcpSourceHealth"] as const) assert.deepEqual(metadata[key], filtered[key]);
  for (const key of ["velocity", "historyProfile", "mcpEvidence"] as const) {
    const bad = structuredClone(filtered);
    assert.ok(bad.sessions[0]![key], `${key} is represented in the fixture`);
    Object.assign(bad.sessions[0]![key]!, { rawContent: "content-is-not-returned" });
    assert.throws(() => validateSnapshot(bad));
  }
  const unknownStart = structuredClone(filtered);
  unknownStart.sessions[0]!.transcript.startTimeKnown = false;
  assert.equal(filterSnapshot(unknownStart).sessions.length, 1);
  assert.equal(filterSnapshot(unknownStart, { start: "2026-07-01T00:00:00Z" }).sessions.length, 0);
});

test("release-scale: the complete metric schema accepts a machine-sized projection and large formatted snapshots", async () => {
  // A single source object keeps this structural budget regression cheap in memory.
  // Cross-session identity and arithmetic are covered by the independent roundtrip tests.
  const complete = snapshot.sessions.find((session) => session.provider === "claude")!;
  const large = { ...snapshot, sessions: Array.from({ length: 8_000 }, () => complete) };
  assert.equal(matchesSchema(large, snapshotSchema), true);
  assert.equal(matchesSchema({ ...large, privateContent: "PRIVATE_SCALE_SENTINEL" }, snapshotSchema), false);

  // JSON formatting alone can cross the former 64 MiB file cap; the measured
  // complete real snapshot also exceeds it when compact. No real data is used.
  const { open } = await import("node:fs/promises");
  const path = join(directory, "large-formatted.json");
  const file = await open(path, "wx", 0o600);
  try {
    const padding = Buffer.alloc(1024 * 1024, 32);
    for (let i = 0; i < 65; i++) await file.write(padding);
    await file.write(JSON.stringify(snapshot));
  } finally { await file.close(); }
  assert.equal((await loadMachineSnapshot(path)).summary.sessions, snapshot.summary.sessions);
  await rm(path);
});
