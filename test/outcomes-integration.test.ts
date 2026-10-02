import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import test from "node:test";
import { analyzeMachineSessions } from "../src/analyzer.ts";
import { OutcomeCollector } from "../src/metrics/outcomes.ts";
import { OutcomeEnricher } from "../src/metrics/outcomes-enrichment.ts";
import type { MachineAnalytics, SessionDatabaseRow } from "../src/types.ts";
import { createOutcomeFixture, outcomeSentinels } from "./outcomes-fixtures.ts";

test("outcomes survive the analyzer, isolated JSON/report surfaces, and optional old/new Conductor schemas without content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outcomes-integration-"));
  try {
    const fixture = await createOutcomeFixture(directory);
    const options = { claudeRoot: fixture.claudeRoot, codexRoot: fixture.codexRoot, codexArchiveRoot: fixture.codexArchiveRoot, cursorDatabasePath: fixture.cursorDatabasePath, databasePath: fixture.databasePath };
    const snapshot = await analyzeMachineSessions(options);
    assert.equal(snapshot.summary.sessions, 5); assert.equal(snapshot.outcomes?.commitSessions, 1);
    assert.equal(snapshot.outcomes?.pullRequests.created, 1); assert.equal(snapshot.outcomes?.pullRequests.merged, 1);
    assert.equal(snapshot.outcomes?.editSessions, 3); assert.equal(snapshot.outcomes?.linesAdded, 37); assert.equal(snapshot.outcomes?.linesRemoved, 9);
    const claude = snapshot.sessions.find((session) => session.provider === "claude")!;
    assert.equal(claude.outcomes?.lineSource, "claude-cost-state"); assert.equal(claude.outcomes?.operations.commits, 1);
    const codex = snapshot.sessions.find((session) => session.provider === "codex" && session.outcomes?.editsObserved)!;
    assert.equal(codex.outcomes?.linesAdded, 2); assert.ok(codex.outcomes?.links.every((link) => link.role === "context"));
    const args = ["bin/session-analytics.ts", "report", ...Object.entries(options).flatMap(([key, value]) => [({ claudeRoot: "--claude-root", codexRoot: "--codex-root", codexArchiveRoot: "--codex-archive-root", cursorDatabasePath: "--cursor-database", databasePath: "--database" } as Record<string, string>)[key]!, value]), "--no-outcomes-git", "--no-outcomes-github"];
    const json = spawnSync(process.execPath, [...args, "--json"], { encoding: "utf8", timeout: 15_000 });
    assert.equal(json.status, 0, json.stderr);
    const isolated = JSON.parse(json.stdout) as MachineAnalytics;
    assert.deepEqual(isolated.outcomes, snapshot.outcomes);
    const report = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 15_000 });
    assert.equal(report.status, 0, report.stderr);
    assert.match(report.stdout, /Identified PRs: 1 linked; 1 created; 1 merged/);
    assert.match(report.stdout, /N\/A \(insufficient-activity\)/);
    for (const value of [JSON.stringify(snapshot), json.stdout, report.stdout]) for (const sentinel of outcomeSentinels) assert.ok(!value.includes(sentinel), `Leaked ${sentinel}`);
    assert.equal(snapshot.repositories.find((repository) => repository.summary.sessions > 0)?.outcomes?.pullRequests.merged, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("real read-only git log parses a synthetic repository without changing its files or exposing messages and emails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outcomes-local-git-"));
  try {
    const git = join(directory, ".git");
    await mkdir(join(git, "objects"), { recursive: true }); await mkdir(join(git, "refs/heads"), { recursive: true });
    const object = async (kind: string, value: string) => {
      const content = Buffer.from(`${kind} ${Buffer.byteLength(value)}\0${value}`);
      const hash = createHash("sha1").update(content).digest("hex");
      await mkdir(join(git, "objects", hash.slice(0, 2)), { recursive: true });
      await writeFile(join(git, "objects", hash.slice(0, 2), hash.slice(2)), deflateSync(content)); return hash;
    };
    const tree = await object("tree", "");
    const seconds = Date.parse("2026-09-01T12:30:00Z") / 1000;
    const commit = await object("commit", `tree ${tree}\nauthor Synthetic <private-email@example.invalid> ${seconds} +0000\ncommitter Synthetic <private-email@example.invalid> ${seconds} +0000\n\nprivate-message-sentinel\n\nCo-authored-by: Codex <private-agent@example.invalid>\nCo-authored-by: Claude <private-agent@example.invalid>\n`);
    await writeFile(join(git, "HEAD"), "ref: refs/heads/synthetic-branch\n");
    await writeFile(join(git, "refs/heads/synthetic-branch"), `${commit}\n`);
    const collector = new OutcomeCollector({ branch: "synthetic-branch", repository_id: "synthetic-key", root_path: directory } as SessionDatabaseRow);
    const before = await readFile(join(git, "refs/heads/synthetic-branch"), "utf8");
    const inheritedGitDir = process.env["GIT_DIR"];
    let result;
    try {
      process.env["GIT_DIR"] = join(directory, "unrelated-private-sentinel");
      result = await collector.finish(new OutcomeEnricher({ outcomesGit: true }), "2026-09-01T12:00:00Z", "2026-09-01T13:00:00Z");
    } finally {
      if (inheritedGitDir === undefined) delete process.env["GIT_DIR"];
      else process.env["GIT_DIR"] = inheritedGitDir;
    }
    assert.equal(result.enrichment.git, "matched"); assert.equal(result.agentCoauthoredCommits, 1);
    assert.equal(result.agentCoauthorTrailers, 2);
    assert.equal(result.links.filter((link) => link.role === "outcome").length, 1);
    assert.equal(await readFile(join(git, "refs/heads/synthetic-branch"), "utf8"), before);
    const output = JSON.stringify(result);
    for (const sentinel of [directory, commit, "private-message", "private-email", "private-agent", "synthetic-branch"]) assert.ok(!output.includes(sentinel));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
