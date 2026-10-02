import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { analyzeMachineSessions, analyzeRepositorySessions } from "../src/analyzer.ts";
import { summarizeWorkflow } from "../src/public/workflow-data.js";
import { loadWorkflowSources } from "../src/metrics/workflow-inventory.ts";
import { workflowReport } from "../src/report/workflow.ts";
import type { MachineAnalytics } from "../src/types.ts";
import { createSessionAnalyticsFixture } from "./fixtures.ts";
import { addWorkflowDemo } from "../scripts/demo-workflow.ts";

const here = dirname(fileURLToPath(import.meta.url));
const forbidden = /WORKFLOW_SECRET|content-is-not-returned|secret-command|secret-path|secret-skill-args|private-turn-id|\/fixtures\/|11111111-1111-4111-8111-111111111111|22222222-2222-4222-8222-222222222222|conductor-claude|transcriptPath/;

test("workflow: parsers, isolated JSON, report and repository output preserve the privacy boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflow-integration-"));
  try {
    const fixture = await createSessionAnalyticsFixture(root);
    const project = join(fixture.claudeRoot, (await readdir(fixture.claudeRoot))[0]!);
    const main = join(project, "22222222-2222-4222-8222-222222222222.jsonl");
    const rows = (await readFile(main, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const row of rows) { row.version = "2.4.0"; row.entrypoint = "sdk-ts"; }
    rows.push(
      { type: "permission-mode", permissionMode: "plan", timestamp: "2026-07-20T12:10:00Z", content: "WORKFLOW_SECRET" },
      { type: "queue-operation", operation: "enqueue", reason: "WORKFLOW_SECRET", content: "WORKFLOW_SECRET", timestamp: "2026-07-20T12:11:00Z" },
      { type: "system", subtype: "turn_duration", durationMs: 720_000, timestamp: "2026-07-20T12:12:00Z", version: "WORKFLOW_SECRET/path", entrypoint: "WORKFLOW_SECRET" },
      { type: "user", uuid: "private-turn-id", timestamp: "2026-07-20T12:13:00Z", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } },
    );
    await writeFile(main, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const child = join(project, "22222222-2222-4222-8222-222222222222", "subagents", "workflow-child.jsonl");
    await writeFile(child, [
      { type: "user", uuid: "WORKFLOW_SECRET_CHILD", timestamp: "2026-07-21T12:00:00Z", message: { content: "WORKFLOW_SECRET automated agent input" } },
      { type: "assistant", uuid: "WORKFLOW_SECRET_CHILD_RESPONSE", timestamp: "2026-07-21T12:01:00Z", version: "9.9.9", message: { id: "WORKFLOW_SECRET_CHILD_MESSAGE", model: "claude-opus-5", content: [{ type: "tool_use", id: "WORKFLOW_SECRET_CHILD_TOOL", name: "Read", input: { path: "WORKFLOW_SECRET" } }], usage: { input_tokens: 500, output_tokens: 100 } } },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const history = [
      { sessionId: "22222222-2222-4222-8222-222222222222", timestamp: Date.parse("2026-07-20T12:00:00Z"), display: "/review WORKFLOW_SECRET /private/file" },
      { sessionId: "WORKFLOW_SECRET_OTHER_SESSION", timestamp: Date.parse("2026-07-20T12:01:00Z"), display: "/outside-scope secret" },
      { sessionId: "22222222-2222-4222-8222-222222222222", timestamp: Date.parse("2026-07-20T12:02:00Z"), display: "/private/path WORKFLOW_SECRET" },
    ];
    await writeFile(join(root, "history.jsonl"), [...history, history[0]].map((r) => JSON.stringify(r)).join("\n") + "\nmalformed-WORKFLOW_SECRET\n");
    await mkdir(join(root, "skills", "demo-unused"), { recursive: true });
    await writeFile(join(root, "skills", "demo-unused", "SKILL.md"), "WORKFLOW_SECRET skill content");
    await mkdir(join(fixture.repositoryRoot, ".agents", "skills", "repo-skill"), { recursive: true });
    await writeFile(join(fixture.repositoryRoot, ".agents", "skills", "repo-skill", "SKILL.md"), "WORKFLOW_SECRET project skill");

    const off = await analyzeMachineSessions(fixture);
    const on = await analyzeMachineSessions({ ...fixture, workflowContentRules: true });
    assert.ok(on.workflow); assert.ok(off.workflow);
    assert.equal(on.workflow.coverage.sessions, 5); assert.equal(on.workflow.coverage.supportedSessions, 3);
    const claude = on.sessions.find((s) => s.provider === "claude")!;
    assert.equal(claude.workflow!.interruptions.claudeMarkers, 1);
    assert.equal(claude.workflow!.humanTurns, 1, "child-agent inputs must not become human turns");
    assert.ok(claude.workflow!.time.activeSpans.every((s) => s.end < "2026-07-21"), "child activity must not extend the parent clock");
    assert.ok(!claude.workflow!.mix.some((m) => m.cliVersion === "9.9.9"));
    assert.ok(claude.metrics.toolCalls > claude.workflow!.toolCalls, "existing accounting still includes children");
    assert.equal(off.sessions.find((s) => s.provider === "claude")!.workflow!.interruptions.claudeMarkers, null);
    assert.deepEqual(claude.workflow!.commands, [{ name: "/review", at: "2026-07-20T12:00:00.000Z" }]);
    assert.equal(claude.workflow!.steering.queueReasons.other, 1);
    assert.ok(on.workflow.installedSkills.some((s) => s.name === "demo-unused" && s.observedInvocations === 0));
    assert.ok(on.workflow.installedSkills.some((s) => s.name === "repo-skill" && s.repositoryId !== null));
    assert.equal(on.workflow.inventory.malformedHistoryRecords, 1);
    assert.deepEqual(on.summary, off.summary, "P2 rules must never change accounting");
    assert.deepEqual(on.sessions.map((s) => s.cost), off.sessions.map((s) => s.cost));
    assert.doesNotMatch(JSON.stringify(on), forbidden);
    assert.doesNotMatch(JSON.stringify(on), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const report = workflowReport(on.workflow, on.repositories);
    assert.match(report, /Workflow/); assert.match(report, /minimum 5/); assert.match(report, /not a failure signal/); assert.doesNotMatch(report, forbidden);
    const repository = await analyzeRepositorySessions({ ...fixture, repositoryName: "conductor", workflowContentRules: true });
    assert.ok(repository.workflow); assert.doesNotMatch(JSON.stringify(repository), forbidden);

    const args = [join(here, "../bin/session-analytics.ts"), "report", "--workflow-content-rules", "--claude-root", fixture.claudeRoot, "--codex-root", fixture.codexRoot, "--codex-archive-root", fixture.codexArchiveRoot, "--cursor-database", fixture.cursorDatabasePath, "--database", fixture.databasePath];
    const json = spawnSync(process.execPath, [...args, "--json"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    assert.equal(json.status, 0, json.stderr); assert.doesNotMatch(json.stdout, forbidden);
    const isolated = JSON.parse(json.stdout) as MachineAnalytics;
    assert.equal(isolated.workflow!.coverage.supportedSessions, 3);
    assert.deepEqual(isolated.workflow!.commands, [{ name: "/review", count: 1 }]);
    const text = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(text.status, 0, text.stderr); assert.match(text.stdout, /Workflow · observed events/); assert.doesNotMatch(text.stdout, forbidden);

    // Browser filters use this exact function, so scope changes cannot retain
    // concurrency or invocation counts from another repository/provider.
    const subset = isolated.sessions.filter((s) => s.provider === "claude");
    const filtered = summarizeWorkflow(subset, { ...isolated.workflow!.inventory, skills: isolated.workflow!.installedSkills }, isolated.generatedAt);
    assert.equal(filtered.concurrency.peak, 1); assert.equal(filtered.coverage.supportedSessions, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("workflow: the synthetic showcase exercises comparable eras, concurrency, history and abandonment", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflow-demo-"));
  try {
    const claudeRoot = join(root, "claude", "projects"), codexRoot = join(root, "codex", "sessions");
    const repositories = [{ root: join(root, "synthetic-one") }, { root: join(root, "synthetic-two") }];
    for (const repo of repositories) await mkdir(join(repo.root, ".git"), { recursive: true });
    addWorkflowDemo(claudeRoot, codexRoot, repositories, Date.now());
    const result = await analyzeMachineSessions({ claudeRoot, codexRoot, cursorDatabasePath: join(root, "missing-cursor"), databasePath: join(root, "missing-conductor"), workflowContentRules: true });
    const w = result.workflow!;
    assert.equal(w.coverage.supportedSessions, 20);
    assert.equal(w.concurrency.peak, 4);
    assert.equal(w.abandonment.flagged, 1);
    assert.deepEqual(w.commands, [{ name: "/plan", count: 2 }, { name: "/review", count: 2 }]);
    const change = w.comparisons.find((c) => c.status === "eligible");
    assert.equal(change?.beforeSessions, 8); assert.equal(change?.afterSessions, 8);
    assert.equal(change?.turnTimeChange, .5);
    assert.equal(w.installedSkills.length, 12);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("workflow: inventories handle symlinks, missing histories and broken skills without returning paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflow-inventory-"));
  try {
    const profile = join(root, "profile"), skills = join(profile, "skills");
    await mkdir(join(skills, ".system", "system-skill"), { recursive: true });
    await writeFile(join(skills, ".system", "system-skill", "SKILL.md"), "WORKFLOW_SECRET");
    await mkdir(join(root, "linked-target"), { recursive: true });
    await writeFile(join(root, "linked-target", "SKILL.md"), "WORKFLOW_SECRET");
    await symlink(join(root, "linked-target"), join(skills, "linked-skill"));
    await symlink(join(root, "missing"), join(skills, "broken-skill"));
    const result = await loadWorkflowSources([join(profile, "projects")], [join(profile, "sessions"), join(profile, "archived_sessions")]);
    assert.equal(result.inventory.historyFilesRead, 0); assert.equal(result.inventory.historyFilesUnavailable, 1);
    assert.deepEqual([...new Set(result.inventory.skills.map((s) => s.name))].sort(), ["linked-skill", "system-skill"]);
    assert.doesNotMatch(JSON.stringify(result.inventory), /WORKFLOW_SECRET|linked-target|broken-skill|profile|tmp/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
