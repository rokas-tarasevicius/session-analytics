import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { analyzeMachineSessions } from "../src/analyzer.ts";
import { combineSnapshots } from "../src/interop/combine.ts";
import { loadMachineSnapshot, validateSnapshot } from "../src/interop/snapshot.ts";
import { duplicateMachineWarning, filteredWarning, indexParityWarning } from "../src/public/evidence.js";
import { filterSnapshot } from "../src/public/export-data.js";
import { indexStatus } from "../src/store/database.ts";
import type { MachineAnalytics, SessionAnalytics } from "../src/types.ts";
import { createSessionAnalyticsFixture, type SessionAnalyticsFixture } from "./fixtures.ts";

const run = promisify(execFile);
const bin = new URL("../bin/session-analytics.ts", import.meta.url).pathname;
const sessionKey = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 12);
const remoteId = (identity: string): string => `discovered-${createHash("sha256").update(`remote:${identity}`).digest("hex").slice(0, 20)}`;
const close = (actual: number, expected: number): void => assert.ok(Math.abs(actual - expected) <= 1e-9 * Math.max(1, expected), `${actual} != ${expected}`);
const identity = ({ provider, sessionKey: key }: SessionAnalytics): string => `${provider}:${key}`;

let directory: string;
let fixture: SessionAnalyticsFixture;
let local: MachineAnalytics;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "combine-fixture-"));
  fixture = await createSessionAnalyticsFixture(directory);
  await writeFile(join(fixture.claudeRoot, "stats-cache.json"), JSON.stringify({
    dailyModelTokensVersion: 5, lastComputedDate: "2026-07-20",
    dailyModelTokens: [{ date: "2026-07-19", tokensByModel: { "claude-opus-5": 1000 } }],
    modelUsage: { "claude-opus-5": { inputTokens: 100, outputTokens: 200, cacheReadInputTokens: 700, cacheCreationInputTokens: 0 } },
  }));
  const { repositoryRoot, remote, ...options } = fixture;
  local = await analyzeMachineSessions(options);
});
after(async () => { await rm(directory, { recursive: true, force: true }); });

/** A second machine: the fixture's session shapes under new keys, optionally regrouped, without the first machine's profiles. */
function otherMachine(regroup: (session: SessionAnalytics) => { repositoryId: string; repositoryName: string } | null = () => null): MachineAnalytics {
  const { historyCoverage, ...source } = structuredClone(local);
  const sessions = source.sessions.map((session) => ({ ...session, ...regroup(session), sessionKey: sessionKey(`other-machine:${identity(session)}`) }));
  const repositories = new Map(source.repositories.map((rollup) => [rollup.repository.id, rollup]));
  for (const { repositoryId: id, repositoryName: name } of sessions) {
    if (!repositories.has(id)) repositories.set(id, { ...source.repositories[0]!, repository: { id, name } });
  }
  const snapshot = filterSnapshot({ ...source, repositories: [...repositories.values()], sessions });
  return validateSnapshot({ ...snapshot, warnings: snapshot.warnings.filter((warning) => warning !== filteredWarning) });
}

test("combining machines unions sessions and repositories and rebuilds every rollup", () => {
  const other = otherMachine((session) => session.provider === "codex" ? { repositoryId: remoteId("github.com/example/other"), repositoryName: "other" } : null);
  const combined = combineSnapshots([local, other]);
  assert.equal(combined.sessions.length, local.sessions.length + other.sessions.length);
  assert.equal(combined.summary.sessions, local.summary.sessions + other.summary.sessions);
  close(combined.summary.estimatedSpendUsd, local.summary.estimatedSpendUsd + other.summary.estimatedSpendUsd);
  assert.equal(combined.summary.toolCalls, local.summary.toolCalls + other.summary.toolCalls);
  const names = [...new Set([...local.repositories, ...other.repositories].map(({ repository }) => repository.name))].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(combined.repositories.map(({ repository }) => repository.name), names);
  for (const rollup of combined.repositories) {
    const sessions = [local, other].flatMap((snapshot) => snapshot.sessions.filter(({ repositoryId }) => repositoryId === rollup.repository.id));
    assert.equal(rollup.summary.sessions, sessions.length);
    close(rollup.summary.estimatedSpendUsd, sessions.reduce((sum, session) => sum + session.cost.totalUsd, 0));
  }
  assert.ok(!combined.warnings.includes(duplicateMachineWarning));
  // The result survives a file round trip, and history months count every machine's dated value.
  validateSnapshot(JSON.parse(JSON.stringify(combined)));
  const months = combined.historyCoverage!.months.reduce((sum, month) => sum + month.sessionEvidenceUsd, 0);
  close(months, combined.sessions.reduce((sum, session) => sum + Object.values(session.spendByDay).reduce((a, b) => a + b, 0), 0));
  assert.deepEqual(combined.historyCoverage!.profiles.map(({ profileKey }) => profileKey), local.historyCoverage!.profiles.map(({ profileKey }) => profileKey));
});

test("a session seen on two machines counts once, from its most complete copy", () => {
  const same = combineSnapshots([local, local]);
  assert.ok(same.warnings.includes(duplicateMachineWarning));
  for (const key of ["sessions", "repositories", "summary", "spendByDay", "spendByModel", "topTools"] as const) assert.deepEqual(same[key], local[key]);
  assert.equal(same.historyCoverage!.profiles.length, local.historyCoverage!.profiles.length * 2);
  const later = structuredClone(local);
  const target = later.sessions[0]!;
  target.lastEventAt = new Date(Date.parse(target.lastEventAt ?? target.updatedAt) + 60_000).toISOString();
  validateSnapshot(later);
  for (const order of [[local, later], [later, local]]) {
    const combined = combineSnapshots(order);
    assert.equal(combined.sessions.length, local.sessions.length);
    assert.equal(combined.sessions.find((session) => identity(session) === identity(target))!.lastEventAt, target.lastEventAt);
  }
});

test("combined generation time is the latest input instant, regardless of order or offset", () => {
  const earlier = validateSnapshot({ ...local, generatedAt: "2026-07-21T12:00:00+02:00" });
  const later = validateSnapshot({ ...otherMachine(), generatedAt: "2026-07-21T11:00:00Z" });
  for (const order of [[earlier, later], [later, earlier]]) assert.equal(combineSnapshots(order).generatedAt, later.generatedAt);
});

test("matching profile paths stay independent per input and winning sessions refer to their machine", () => {
  const other = otherMachine();
  other.historyCoverage = structuredClone(local.historyCoverage!);
  validateSnapshot(other);
  const original = structuredClone([local, other]);
  const combined = combineSnapshots([local, other]);
  const count = local.historyCoverage!.profiles.length, profiles = combined.historyCoverage!.profiles;
  assert.deepEqual(profiles.slice(0, count), local.historyCoverage!.profiles);
  assert.equal(profiles.length, count * 2);
  assert.equal(new Set(profiles.map(({ profileKey }) => profileKey)).size, count * 2);
  assert.deepEqual(profiles.map(({ ordinal }) => ordinal), profiles.map((_, index) => index + 1));
  for (const profile of profiles) assert.match(profile.profileKey, /^profile-[a-f0-9]{20}$/);
  for (const session of other.sessions.filter(({ historyProfile }) => historyProfile)) {
    const merged = combined.sessions.find((row) => identity(row) === identity(session))!;
    const position = local.historyCoverage!.profiles.findIndex(({ profileKey }) => profileKey === session.historyProfile!.profileKey);
    assert.equal(merged.historyProfile!.profileKey, profiles[count + position]!.profileKey);
  }
  const stats = ["statisticsCells", "unattributedTokens", "pricedUnattributedTokens", "possibleOverlapTokens", "unattributedEstimateUsd"] as const;
  assert.ok(local.historyCoverage!.months.some(({ unattributedTokens }) => unattributedTokens > 0));
  for (const row of combined.historyCoverage!.months) for (const key of stats) close(row[key], local.historyCoverage!.months.find(({ month }) => month === row.month)![key] * 2);
  assert.deepEqual(combineSnapshots([local, other]), combined);
  assert.deepEqual([local, other], original);
  const later = structuredClone(local);
  const target = later.sessions.find(({ historyProfile }) => historyProfile)!;
  target.lastEventAt = new Date(Date.parse(target.lastEventAt!) + 60_000).toISOString();
  const repeated = combineSnapshots([local, validateSnapshot(later)]);
  assert.equal(repeated.sessions.length, local.sessions.length);
  assert.ok(repeated.warnings.includes(duplicateMachineWarning));
  assert.equal(repeated.sessions.find((row) => identity(row) === identity(target))!.historyProfile!.profileKey, profiles[count]!.profileKey);
  for (const row of repeated.historyCoverage!.months) {
    const source = local.historyCoverage!.months.find(({ month }) => month === row.month)!;
    for (const key of stats) close(row[key], source[key] * 2);
    close(row.sessionEvidenceUsd, source.sessionEvidenceUsd);
  }
  validateSnapshot(JSON.parse(JSON.stringify(repeated)));
});

test("time-zone metadata compares fields independently of serialization order", () => {
  const other = validateSnapshot({ ...otherMachine(), velocity: { timeZone: local.velocity!.timeZone, version: 1 } });
  assert.equal(combineSnapshots([local, other]).summary.sessions, local.summary.sessions * 2);
  const { velocity, ...withoutZone } = structuredClone(local);
  assert.equal(combineSnapshots([validateSnapshot(withoutZone), validateSnapshot(withoutZone)]).velocity, undefined);
  assert.throws(() => combineSnapshots([local, validateSnapshot(withoutZone)]), /different analysis time zones/);
});

test("the first machine names a shared repository; other time zones are refused", () => {
  const [rollup] = local.repositories.filter(({ summary }) => summary.sessions > 0);
  const other = otherMachine();
  const rename = <T extends { repositoryId: string; repositoryName: string }>(row: T): T => row.repositoryId === rollup!.repository.id ? { ...row, repositoryName: "renamed-elsewhere" } : row;
  const renamed = filterSnapshot({ ...other, sessions: other.sessions.map(rename),
    repositories: other.repositories.map((row) => row.repository.id === rollup!.repository.id ? { ...row, repository: { ...row.repository, name: "renamed-elsewhere" } } : row) });
  const combined = combineSnapshots([local, validateSnapshot({ ...renamed, warnings: renamed.warnings.filter((warning) => warning !== filteredWarning) })]);
  const shared = combined.repositories.filter(({ repository }) => repository.id === rollup!.repository.id);
  assert.deepEqual(shared.map(({ repository }) => repository.name), [rollup!.repository.name]);
  assert.ok(combined.sessions.filter(({ repositoryId }) => repositoryId === rollup!.repository.id).every(({ repositoryName }) => repositoryName === rollup!.repository.name));
  const tokyo = { ...otherMachine(), velocity: { version: 1 as const, timeZone: "Asia/Tokyo" } };
  assert.throws(() => combineSnapshots([local, tokyo]), /different analysis time zones/);
  assert.throws(() => combineSnapshots([]), /at least one/);
});

test("portable IDs give remote-backed registrations the ID every machine derives, without reparsing", async () => {
  const { repositoryRoot, remote, ...options } = fixture;
  const portable = await analyzeMachineSessions({ ...options, portableIds: true });
  const expected = remoteId("github.com/example/conductor");
  const conductor = local.repositories.find(({ repository }) => repository.name === "conductor")!;
  assert.match(conductor.repository.id, /^conductor-/);
  assert.deepEqual(portable.repositories.find(({ repository }) => repository.name === "conductor")!.repository, { id: expected, name: "conductor" });
  assert.equal(portable.repositories.filter(({ repository }) => repository.id.startsWith("conductor-")).length, 0);
  for (const [provider, id] of [["claude", "22222222-2222-4222-8222-222222222222"], ["codex", "11111111-1111-4111-8111-111111111111"]]) {
    assert.ok(portable.sessions.some((session) => identity(session) === `${provider}:${sessionKey(`${provider}:${id}`)}`));
  }
  assert.deepEqual(portable.sessions.filter(({ provider }) => provider === "cursor").map(identity), local.sessions.filter(({ provider }) => provider === "cursor").map(identity));
  assert.ok(portable.sessions.filter(({ repositoryName }) => repositoryName === "conductor").every(({ repositoryId }) => repositoryId === expected));
  close(portable.summary.estimatedSpendUsd, local.summary.estimatedSpendUsd);
  const selected = await analyzeMachineSessions({ ...options, portableIds: true, repositoryId: expected });
  assert.deepEqual(selected.repositories.map(({ repository }) => repository.id), [expected]);
  // Portable output is a projection: an indexed scan reuses every session cached under local IDs.
  const indexed = { ...options, noIndex: false, dataDir: join(directory, "portable-index") };
  await analyzeMachineSessions(indexed);
  const parsed = indexStatus(indexed).lastScan?.parsedSessions ?? 0;
  assert.ok(parsed > 0);
  const warm = await analyzeMachineSessions({ ...indexed, portableIds: true });
  assert.equal(indexStatus(indexed).lastScan?.parsedSessions, 0);
  assert.equal(indexStatus(indexed).lastScan?.reusedSessions, parsed);
  assert.deepEqual(warm.repositories.map(({ repository }) => repository.id), portable.repositories.map(({ repository }) => repository.id));
  assert.deepEqual(warm.sessions.map(identity), portable.sessions.map(identity));
  const localWarm = await analyzeMachineSessions(indexed);
  assert.deepEqual(localWarm.sessions.map(identity), local.sessions.map(identity));
  assert.equal(indexStatus(indexed).lastScan?.parsedSessions, 0);
});

test("portable session keys deduplicate transcripts copied without Conductor registration", async () => {
  const { repositoryRoot, remote, ...options } = fixture;
  const registered = await analyzeMachineSessions({ ...options, portableIds: true });
  const discovered = await analyzeMachineSessions({ ...options, databasePath: join(directory, "absent-conductor.db"), portableIds: true });
  assert.deepEqual(discovered.sessions.map(identity).sort(), registered.sessions.map(identity).sort());
  const combined = combineSnapshots([registered, discovered]);
  assert.equal(combined.summary.sessions, registered.summary.sessions);
  close(combined.summary.estimatedSpendUsd, registered.summary.estimatedSpendUsd);
  assert.equal(combined.summary.totalInputTokens, registered.summary.totalInputTokens);
  assert.equal(combined.summary.outputTokens, registered.summary.outputTokens);
  assert.ok(combined.warnings.includes(duplicateMachineWarning));
  const duplicateFixture = await createSessionAnalyticsFixture(join(directory, "duplicate-registrations"));
  const db = new DatabaseSync(duplicateFixture.databasePath);
  db.exec("INSERT INTO sessions SELECT 'duplicate-registration',status,agent_type,title,created_at,updated_at,claude_session_id,model,is_hidden,workspace_id FROM sessions WHERE id='conductor-claude'");
  db.exec("UPDATE sessions SET claude_session_id=NULL WHERE id='conductor-codex'");
  db.close();
  const snapshot = await analyzeMachineSessions({ ...duplicateFixture, repositoryRoot: undefined, portableIds: true });
  assert.equal(new Set(snapshot.sessions.map(identity)).size, snapshot.sessions.length);
  assert.equal(snapshot.sessions.length, registered.sessions.length);
  assert.ok(snapshot.sessions.some(({ sessionKey: key }) => key === sessionKey("conductor-codex")), "legacy registrations retain their local keys");
  validateSnapshot(snapshot);
});

test("portable projection resolves colliding session keys before rebuilding rollups", async () => {
  const fixture = await createSessionAnalyticsFixture(join(directory, "session-key-collision"));
  const db = new DatabaseSync(fixture.databasePath);
  db.prepare("INSERT INTO workspaces (id,repository_id,workspace_path) VALUES ('archive-workspace','repository-1',?)").run(fixture.repositoryRoot);
  db.exec("INSERT INTO sessions SELECT 'codex:11111111-1111-4111-8111-111111111111',status,agent_type,title,'2026-07-18T10:00:00Z',updated_at,NULL,model,is_hidden,'archive-workspace' FROM sessions WHERE id='conductor-codex'");
  db.close();
  const options = { ...fixture, repositoryRoot: undefined };
  const local = await analyzeMachineSessions(options);
  const portable = await analyzeMachineSessions({ ...options, portableIds: true });
  const key = sessionKey("codex:11111111-1111-4111-8111-111111111111");
  assert.equal(local.sessions.filter(({ sessionKey }) => sessionKey === key).length, 1);
  assert.equal(portable.sessions.length, local.sessions.length - 1);
  assert.equal(new Set(portable.sessions.map(identity)).size, portable.sessions.length);
  const winner = portable.sessions.find(({ provider, sessionKey }) => provider === "codex" && sessionKey === key)!;
  assert.equal(winner.lastEventAt, local.sessions.find(({ sessionKey: key }) => key === sessionKey("conductor-codex"))!.lastEventAt);
  validateSnapshot(portable);
});

test("portable local Git IDs depend on the machine, support selection and leave shared groups unchanged", async (t) => {
  const root = join(directory, "local-git"), fixture = await createSessionAnalyticsFixture(root);
  await run("git", ["init", "--quiet", fixture.repositoryRoot]);
  const transcript = join(fixture.codexRoot, "2026/07/20/rollout-2026-07-20T10-00-00-11111111-1111-4111-8111-111111111111.jsonl");
  await writeFile(transcript, (await readFile(transcript, "utf8")).replaceAll("/fixtures/workspaces/conductor/codex-workspace", fixture.repositoryRoot));
  const { repositoryRoot, remote, ...options } = fixture;
  const indexed = { ...options, databasePath: join(root, "absent.db"), noIndex: false };
  const host = t.mock.method(os, "hostname", () => "machine-a");
  syncBuiltinESMExports();
  try {
    const local = await analyzeMachineSessions(indexed);
    const parsed = indexStatus(indexed).lastScan!.parsedSessions;
    const first = await analyzeMachineSessions({ ...indexed, portableIds: true });
    const id = `discovered-${createHash("sha256").update(JSON.stringify(["local", "machine-a", repositoryRoot])).digest("hex").slice(0, 20)}`;
    assert.ok(first.repositories.some(({ repository }) => repository.id === id));
    assert.equal(indexStatus(indexed).lastScan!.parsedSessions, 0);
    assert.equal(indexStatus(indexed).lastScan!.reusedSessions, parsed);
    assert.deepEqual((await analyzeMachineSessions({ ...indexed, portableIds: true, repositoryId: id })).repositories.map(({ repository }) => repository.id), [id]);
    host.mock.mockImplementation(() => "machine-b");
    const second = await analyzeMachineSessions({ ...indexed, portableIds: true });
    const localIds = local.repositories.filter(({ repository }) => repository.name !== "repository").map(({ repository }) => repository.id);
    for (const snapshot of [first, second]) assert.deepEqual(snapshot.repositories.filter(({ repository }) => repository.name !== "repository").map(({ repository }) => repository.id), localIds);
    const secondId = second.repositories.find(({ repository }) => repository.name === "repository")!.repository.id;
    assert.notEqual(secondId, id);
    assert.match(secondId, /^discovered-[a-f0-9]{20}$/);
    assert.equal(indexStatus(indexed).lastScan!.parsedSessions, 0);
    assert.deepEqual((await analyzeMachineSessions({ ...indexed, portableIds: true, repositoryId: secondId })).repositories.map(({ repository }) => repository.id), [secondId]);
    const combined = combineSnapshots([first, { ...second, sessions: second.sessions.map((session) => ({ ...session, sessionKey: sessionKey(`machine-b:${identity(session)}`) })) }]);
    assert.equal(combined.repositories.filter(({ repository }) => repository.name === "repository").length, 2);
    const db = new DatabaseSync(fixture.databasePath);
    db.exec("UPDATE repos SET remote_url=NULL"); db.close();
    const registered = await analyzeMachineSessions({ ...options, portableIds: true });
    assert.equal(registered.repositories.find(({ repository }) => repository.name === "conductor")!.repository.id,
      `conductor-${createHash("sha256").update("conductor:repository-1").digest("hex").slice(0, 20)}`);
    await run("git", ["-C", repositoryRoot, "remote", "add", "origin", remote]);
    const remoteSnapshot = await analyzeMachineSessions({ ...options, databasePath: indexed.databasePath, portableIds: true });
    assert.ok(remoteSnapshot.repositories.some(({ repository }) => repository.id === remoteId("github.com/example/conductor")));
  } finally { host.mock.restore(); syncBuiltinESMExports(); }
});

test("--time-zone moves activity cells, reaches the worker and is part of index reuse", async () => {
  const flags = ["--claude-root", fixture.claudeRoot, "--codex-root", fixture.codexRoot, "--codex-archive-root", fixture.codexArchiveRoot,
    "--database", fixture.databasePath, "--cursor-database", fixture.cursorDatabasePath, "--no-additional-providers", "--offline", "--data-dir", join(directory, "zones")];
  const report = async (zone: string): Promise<MachineAnalytics> => validateSnapshot(JSON.parse((await run(process.execPath, [bin, "report", "--json", "--time-zone", zone, ...flags])).stdout));
  const cells = (snapshot: MachineAnalytics, shiftHours = 0): string[] => snapshot.sessions.flatMap((session) => (session.velocity?.buckets ?? []).map(([day, hour, dimension]) => {
    const instant = new Date(Date.parse(`${day}T00:00:00Z`) + (hour + shiftHours) * 3_600_000).toISOString();
    return `${identity(session)}|${instant.slice(0, 10)}|${Number(instant.slice(11, 13))}|${dimension}`;
  })).sort();
  const index = { dataDir: join(directory, "zones") };
  const utc = await report("UTC");
  const parsed = indexStatus(index).lastScan?.parsedSessions ?? 0;
  assert.ok(parsed > 0);
  await report("UTC");
  assert.equal(indexStatus(index).lastScan?.reusedSessions, parsed);
  // Cells cached under UTC are parsed again rather than failing the index audit on every later scan.
  const tokyo = await report("asia/tokyo");
  assert.equal(indexStatus(index).lastScan?.parsedSessions, parsed);
  assert.ok(!tokyo.warnings.includes(indexParityWarning));
  await report("Asia/Tokyo");
  assert.equal(indexStatus(index).lastScan?.reusedSessions, parsed);
  assert.equal(utc.velocity?.timeZone, "UTC");
  assert.equal(tokyo.velocity?.timeZone, "Asia/Tokyo");
  assert.ok(cells(utc).length > 0);
  assert.deepEqual(cells(tokyo), cells(utc, 9));
  close(tokyo.summary.estimatedSpendUsd, utc.summary.estimatedSpendUsd);
  for (const zone of ["Mars/Base", "Europe/London;id", "../../etc/localtime"]) {
    const invalid = spawnSync(process.execPath, [bin, "report", "--json", "--time-zone", zone], { encoding: "utf8" });
    assert.equal(invalid.status, 2);
    assert.equal(invalid.stdout, "");
    assert.match(invalid.stderr, /IANA time zone/);
  }
});

test("merge combines full snapshots from several machines and refuses mixed or misaligned inputs", async () => {
  const first = join(directory, "machine-a.json"), second = join(directory, "machine-b.json"), tokyo = join(directory, "machine-tokyo.json");
  await writeFile(first, JSON.stringify(local));
  await writeFile(second, JSON.stringify(otherMachine()));
  await writeFile(tokyo, JSON.stringify({ ...otherMachine(), velocity: { version: 1, timeZone: "Asia/Tokyo" } }));
  const output = join(directory, "machines.json");
  await run(process.execPath, [bin, "merge", first, second, "--out", output]);
  const merged = await loadMachineSnapshot(output);
  assert.equal(merged.summary.sessions, local.summary.sessions * 2);
  const report = await run(process.execPath, [bin, "report", "--json", "--snapshot", output]);
  assert.deepEqual(JSON.parse(report.stdout), merged);
  const refused = spawnSync(process.execPath, [bin, "merge", first, tokyo], { encoding: "utf8" });
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, "");
  assert.match(refused.stderr, /same --time-zone/);
});
