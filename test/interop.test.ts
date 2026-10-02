import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  return filterSnapshot({ ...snapshot, sessions });
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
    (s: any) => { s.sessions[0].provider = "unsupported"; },
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
  const filtered = filterSnapshot(snapshot, { providers: ["claude"], repositoryId: source.repositoryId, start: source.createdAt, end: source.createdAt });
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
