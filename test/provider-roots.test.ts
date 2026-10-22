import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import test from "node:test";
import { snapshotSchemas } from "../scripts/snapshot-schema.ts";
import { validateSnapshot } from "../src/interop/snapshot.ts";
import { matchesSchema } from "../src/interop/schema.ts";
import { harness } from "./validation/aggregation-ui-harness.ts";
import { discoverProviderRoots } from "../src/analyzer.ts";
import { buildPayload } from "../src/mcp/metrics.ts";
import { antigravityAdapter } from "../src/providers/antigravity.ts";
import { copilotAdapter } from "../src/providers/copilot.ts";
import { cursorSdkAdapter } from "../src/providers/cursor-sdk.ts";
import { cursorTranscriptAdapter } from "../src/providers/cursor-transcript.ts";
import { geminiAdapter } from "../src/providers/gemini.ts";
import { opencodeAdapter } from "../src/providers/opencode.ts";
import { additionalProviderSessions } from "../src/providers/index.ts";
import { cursorDatabaseDefault, providerRoots } from "../src/providers/roots.ts";
import type { AnalyzeOptions, MachineAnalytics } from "../src/types.ts";

async function fixture(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "provider-roots-"));
  try { await run(home); } finally { await rm(home, { recursive: true, force: true }); }
}

test("absent native defaults, including the optional Codex archive, are not missing sources", async () => {
  await fixture(async (home) => {
    assert.deepEqual(await discoverProviderRoots({ home }), { claude: [], codex: [] });
    const sessions = join(home, ".codex/sessions");
    await mkdir(sessions, { recursive: true });
    assert.deepEqual(await discoverProviderRoots({ home }), { claude: [], codex: [sessions] });
  });
});

const adapters = [cursorSdkAdapter, cursorTranscriptAdapter(), copilotAdapter, opencodeAdapter, geminiAdapter(), antigravityAdapter()];
for (const adapter of adapters) test(`${adapter.id}: absent defaults are not discovered`, async () => {
  await fixture(async (home) => {
    assert.deepEqual(await adapter.discoverRoots({ home, options: {}, environment: {} }), []);
  });
});

test("existing stores remain discoverable with an injected XDG environment", async () => {
  await fixture(async (home) => {
    const data = join(home, "xdg-data"), database = join(data, "opencode/opencode.db");
    await mkdir(join(data, "opencode"), { recursive: true });
    await writeFile(database, "");
    assert.deepEqual(await opencodeAdapter.discoverRoots({ home, options: {}, environment: { XDG_DATA_HOME: data } }), [database]);
  });
});

test("Gemini-only homes do not count as Antigravity sources, but its app, IDE and CLI stores do", async () => {
  await fixture(async (home) => {
    const adapter = antigravityAdapter(), environment = { home, options: {}, environment: {} };
    await mkdir(join(home, ".gemini/tmp"), { recursive: true });
    assert.deepEqual(await adapter.discoverRoots(environment), []);
    for (const surface of ["antigravity", "antigravity-ide", "antigravity-cli"]) {
      const store = join(home, ".gemini", surface, "conversations");
      await mkdir(store, { recursive: true });
      assert.deepEqual(await adapter.discoverRoots(environment), [join(home, ".gemini")]);
      await rm(join(home, ".gemini", surface), { recursive: true });
    }
    const invalid = join(home, ".gemini/antigravity/conversations");
    await mkdir(join(invalid, ".."), { recursive: true });
    await writeFile(invalid, "PRIVATE-SOURCE-SENTINEL");
    assert.deepEqual(await adapter.discoverRoots(environment), [join(home, ".gemini")]);
    const warnings: string[] = [];
    for await (const _identity of adapter.identify(join(home, ".gemini"), (warning) => warnings.push(warning))) assert.fail("Invalid store cannot contain sessions");
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(JSON.stringify(warnings), /PRIVATE-SOURCE-SENTINEL|ENOTDIR/);
  });
});

test("Cursor defaults use the injected platform and environment", () => {
  const home = "/synthetic-home";
  assert.equal(cursorDatabaseDefault({ home, platform: "darwin", environment: { XDG_CONFIG_HOME: "/ignored", APPDATA: "/ignored" } }), "/synthetic-home/Library/Application Support/Cursor/User/globalStorage/state.vscdb");
  assert.equal(cursorDatabaseDefault({ home, platform: "linux", environment: {} }), "/synthetic-home/.config/Cursor/User/globalStorage/state.vscdb");
  assert.equal(cursorDatabaseDefault({ home, platform: "linux", environment: { XDG_CONFIG_HOME: "/synthetic-config" } }), "/synthetic-config/Cursor/User/globalStorage/state.vscdb");
  assert.equal(cursorDatabaseDefault({ home, platform: "linux", environment: { XDG_CONFIG_HOME: "" } }), "/synthetic-home/.config/Cursor/User/globalStorage/state.vscdb");
  const windowsHome = "C:\\Users\\synthetic";
  assert.equal(cursorDatabaseDefault({ home: windowsHome, platform: "win32", environment: { APPDATA: "D:\\Roaming", XDG_CONFIG_HOME: "/ignored" } }), "D:\\Roaming\\Cursor\\User\\globalStorage\\state.vscdb");
  assert.equal(cursorDatabaseDefault({ home: windowsHome, platform: "win32", environment: {} }), "C:\\Users\\synthetic\\AppData\\Roaming\\Cursor\\User\\globalStorage\\state.vscdb");
});

test("optional discovery preserves invalid or unreadable stores for the reader", async () => {
  await fixture(async (home) => {
    const loop = join(home, ".codex");
    await symlink(loop, loop);
    assert.deepEqual(await discoverProviderRoots({ home }), { claude: [], codex: [join(loop, "sessions"), join(loop, "archived_sessions")] });
    const invalid = join(home, "not-a-directory");
    await writeFile(invalid, "PRIVATE-SOURCE-SENTINEL");
    assert.deepEqual(await providerRoots(undefined, [invalid, join(invalid, "store")]), [invalid, join(invalid, "store")]);
    assert.deepEqual(await providerRoots(join(home, "explicit-missing"), [invalid]), [join(home, "explicit-missing")]);
  });
});

test("explicit additional roots replace defaults and report missing sources consistently", async () => {
  await fixture(async (home) => {
    const missing = join(home, "PRIVATE-SOURCE-SENTINEL");
    const options: AnalyzeOptions = { additionalProviders: false, cursorSdkRoot: missing, cursorTranscriptRoot: missing,
      copilotRoot: missing, opencodeDatabasePath: missing, geminiRoot: missing, antigravityRoot: missing };
    // Existing default roots must not enter an explicitly narrowed scan.
    await mkdir(join(home, ".copilot/session-state"), { recursive: true });
    for (const adapter of adapters) assert.deepEqual(await adapter.discoverRoots({ home, options, environment: {} }), [missing]);
    const result = await additionalProviderSessions({ home, options, environment: {}, knownPaths: [], existingSessions: [],
      pricing: { rateCard: { currency: "USD", effectiveDate: "2026-10-22", models: {} }, price() { throw new Error("Unexpected pricing"); } },
      async repositoryForSession() { throw new Error("Unexpected evidence"); } });
    assert.deepEqual(result.sessions, []);
    assert.deepEqual(result.warnings, ["A provider transcript root is missing."]);
    assert.equal(result.sources.get("cursor")?.length, 2);
    for (const warnings of result.sources.values()) assert.ok(warnings.every((warning) => warning === "A provider transcript root is missing."));
    assert.doesNotMatch(JSON.stringify({ sessions: result.sessions, warnings: result.warnings }), /PRIVATE-SOURCE-SENTINEL|ENOENT/);
  });
});

test("unreadable additional stores stay visible without exposing local errors", async () => {
  await fixture(async (home) => {
    const invalid = join(home, "PRIVATE-SOURCE-SENTINEL");
    await writeFile(invalid, "not a database or directory");
    const result = await additionalProviderSessions({ home, options: { additionalProviders: false, cursorSdkRoot: invalid, cursorTranscriptRoot: invalid,
      copilotRoot: invalid, opencodeDatabasePath: invalid, geminiRoot: invalid, antigravityRoot: invalid }, environment: {}, knownPaths: [], existingSessions: [],
      pricing: { rateCard: { currency: "USD", effectiveDate: "2026-10-22", models: {} }, price() { throw new Error("Unexpected pricing"); } },
      async repositoryForSession() { throw new Error("Unexpected evidence"); } });
    assert.equal(result.sources.size, 5);
    assert.ok(result.warnings.length > 0);
    for (const warnings of result.sources.values()) assert.ok(warnings.length && warnings.every((warning) => warning && !warning.includes("missing")));
    assert.doesNotMatch(JSON.stringify({ sessions: result.sessions, warnings: result.warnings }), /PRIVATE-SOURCE-SENTINEL|ENOENT|ENOTDIR|SQLITE/);
  });
});

const run = promisify(execFile);
async function report(home: string, flags: string[] = []): Promise<MachineAnalytics> {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(SESSION_ANALYTICS_|CLAUDE_|CODEX_|CONDUCTOR_|MACHINE_)/.test(key)) environment[key] = value;
  }
  Object.assign(environment, { HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData/Roaming"), XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share") });
  // Every discovered default is inside this synthetic HOME; no real provider store can be read.
  const result = await run(process.execPath, [new URL("../bin/session-analytics.ts", import.meta.url).pathname, "report", "--json", "--offline", "--no-remote", "--no-index", "--data-dir", join(home, "analytics-data"), ...flags], { env: environment, timeout: 60_000 });
  assert.doesNotMatch(result.stdout, /PRIVATE-SOURCE-SENTINEL|ENOENT|ENOTDIR|ELOOP/);
  return JSON.parse(result.stdout) as MachineAnalytics;
}

test("an absent default provider is unavailable with zero missing sources in the report", async () => {
  await fixture(async (home) => {
    const empty = await report(home);
    assert.deepEqual(empty.warnings, []);
    assert.equal(empty.mcpSourceHealth?.length, 7);
    for (const health of empty.mcpSourceHealth ?? []) assert.deepEqual(health, {
      provider: health.provider, status: "unavailable", sourcesRead: 0, missingSources: 0, unreadableSources: 0,
    });
    assert.doesNotMatch(buildPayload({ analytics: empty }, "usage_summary", { window: "all" }, Date.now(), 60).notes.join(" "), /sources.*incomplete/);
    await mkdir(join(home, ".codex/sessions"), { recursive: true });
    const databasePath = cursorDatabaseDefault({ home, environment: {} });
    await mkdir(join(databasePath, ".."), { recursive: true });
    const db = new DatabaseSync(databasePath);
    db.exec("CREATE TABLE cursorDiskKV (key TEXT, value TEXT); CREATE TABLE ItemTable (key TEXT, value TEXT)");
    db.close();
    const installed = await report(home);
    assert.deepEqual(installed.warnings, []);
    for (const provider of ["codex", "cursor"]) assert.deepEqual(installed.mcpSourceHealth?.find((health) => health.provider === provider), {
      provider, status: "available", sourcesRead: 1, missingSources: 0, unreadableSources: 0,
    });
  });
});

test("explicit missing native stores remain missing while raw source details stay private", async () => {
  await fixture(async (home) => {
    const missing = join(home, "PRIVATE-SOURCE-SENTINEL");
    const snapshot = await report(home, ["--claude-root", missing, "--codex-root", missing, "--codex-archive-root", missing, "--cursor-database", missing]);
    for (const provider of ["claude", "codex", "cursor"]) assert.deepEqual(snapshot.mcpSourceHealth?.find((health) => health.provider === provider), {
      provider, status: "unavailable", sourcesRead: 0, missingSources: provider === "codex" ? 2 : 1, unreadableSources: 0,
    });
    assert.ok(snapshot.warnings.includes("Cursor local session history is missing."));
    assert.match(buildPayload({ analytics: snapshot }, "usage_summary", { window: "all" }, Date.now(), 60).notes.join(" "), /sources.*incomplete/);
  });
});

test("unreadable native defaults are not treated as uninstalled", async () => {
  await fixture(async (home) => {
    await symlink(join(home, ".codex"), join(home, ".codex"));
    const snapshot = await report(home);
    assert.deepEqual(snapshot.mcpSourceHealth?.find((health) => health.provider === "codex"), {
      provider: "codex", status: "unavailable", sourcesRead: 0, missingSources: 0, unreadableSources: 2,
    });
    assert.ok(snapshot.warnings.includes("A provider transcript root could not be read."));
  });
});


test("mixed native-root failures remain separate schema-valid Coverage notes", async () => {
  await fixture(async (home) => {
    const unreadable = join(home, "PRIVATE-SOURCE-SENTINEL");
    await writeFile(unreadable, "not a directory");
    const snapshot = await report(home, ["--codex-root", join(home, "absent"), "--codex-archive-root", unreadable]);
    const warnings = ["A provider transcript root is missing.", "A provider transcript root could not be read."];
    assert.deepEqual(snapshot.warnings, warnings);
    assert.equal(matchesSchema(snapshot, snapshotSchemas()["snapshot.v1.schema.json"]!), true);
    assert.deepEqual(validateSnapshot(JSON.parse(JSON.stringify(snapshot))), snapshot);
    const { document, run } = await harness([]);
    run(`render(${JSON.stringify(snapshot)}); openCoverage()`);
    assert.equal(document.querySelector("#coverage-dialog")!.open, true);
    const notes = document.querySelector("#warning-list")!.children.map((item) => item.textContent);
    for (const warning of warnings) assert.ok(notes.includes(warning), notes.join("\n"));
  });
});

test("dangling default transcript, profile and database links remain missing sources", async () => {
  await fixture(async (home) => {
    await mkdir(join(home, ".codex"));
    await symlink(join(home, "PRIVATE-SOURCE-SENTINEL"), join(home, ".codex/sessions"));
    const database = cursorDatabaseDefault({ home, environment: {} });
    await mkdir(join(database, ".."), { recursive: true });
    await symlink(join(home, "PRIVATE-SOURCE-SENTINEL"), database);
    assert.deepEqual(await discoverProviderRoots({ home }), { claude: [], codex: [join(home, ".codex/sessions")] });
    assert.deepEqual(await providerRoots(undefined, [database]), [database]);
    const snapshot = await report(home);
    for (const provider of ["codex", "cursor"]) assert.deepEqual(snapshot.mcpSourceHealth?.find((row) => row.provider === provider), {
      provider, status: "unavailable", sourcesRead: 0, missingSources: 1, unreadableSources: 0,
    });
    await symlink(join(home, "PRIVATE-SOURCE-SENTINEL"), join(home, ".claude-linked"));
    assert.deepEqual((await discoverProviderRoots({ home })).claude, [join(home, ".claude-linked/projects")]);
    const validProfile = join(home, "valid-profile");
    await mkdir(validProfile);
    await symlink(validProfile, join(home, ".claude-empty"));
    assert.deepEqual((await discoverProviderRoots({ home })).claude, [join(home, ".claude-linked/projects")]);
  });
});
