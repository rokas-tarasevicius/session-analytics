import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { analyzeMachineSessions } from "../src/analyzer.ts";
import { OutcomeCollector } from "../src/metrics/outcomes.ts";
import { OutcomeEnricher, type OutcomeCommand } from "../src/metrics/outcomes-enrichment.ts";
import { outcomeReport } from "../src/metrics/outcomes-report.ts";
import { summarizeOutcomes } from "../src/metrics/outcomes-summary.js";
import type { SessionAnalytics, SessionDatabaseRow } from "../src/types.ts";
import { createSessionAnalyticsFixture } from "./fixtures.ts";

const secret = "review-private-content-path-branch-error";
const at = (minute: number) => `2026-07-20T12:${String(minute).padStart(2, "0")}:00Z`;
const edit = (id: string, minute?: number, measured = true) => ({
  type: "user", timestamp: minute === undefined ? undefined : at(minute), uuid: `uuid-${id}`,
  toolUseResult: measured ? { structuredPatch: [{ lines: [`+${secret}`, "+second"] }], filePath: secret } : { type: "create", filePath: secret },
  message: { content: [{ type: "tool_result", tool_use_id: id, content: secret }] },
});
const call = (id: string) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Edit", input: { path: secret } }] } });
const counter = (added: number, minute: number) => ({ type: "cost-state", timestamp: at(minute), totalLinesAdded: added, totalLinesRemoved: 0 });
const row = () => ({ repository_id: "synthetic-repo", conductor_session_id: "synthetic-session", branch: null } as SessionDatabaseRow);
const priced = (outcomes: SessionAnalytics["outcomes"], totalUsd = 2) => ({ outcomes, cost: { totalUsd }, costBasis: "api-list-price-equivalent", costComplete: true, pricedTokenCoverage: 1 } as SessionAnalytics);
function privateOutput(value: unknown) { assert.ok(!JSON.stringify(value).includes(secret)); }

async function analyzeClaude(main: unknown[], children: unknown[][] = []) {
  const directory = await mkdtemp(join(tmpdir(), "outcomes-review-"));
  try {
    const fixture = await createSessionAnalyticsFixture(directory);
    const id = "22222222-2222-4222-8222-222222222222";
    const path = join(fixture.claudeRoot, "-fixtures-workspaces-conductor-claude-workspace", `${id}.jsonl`);
    const base = { sessionId: id, cwd: "/fixtures/workspaces/conductor/claude-workspace", timestamp: at(0) };
    const save = async (path: string, records: unknown[]) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, records.map((record) => JSON.stringify({ ...base, ...record as object })).join("\n") + "\n");
    };
    await save(path, [{ type: "system" }, ...main]);
    const subagents = join(path.slice(0, -6), "subagents");
    await rm(subagents, { recursive: true, force: true });
    for (const [index, records] of children.entries()) await save(join(subagents, `agent-${index}.jsonl`), records);
    const snapshot = await analyzeMachineSessions(fixture);
    privateOutput(snapshot);
    return snapshot.sessions.find((session) => session.provider === "claude")!;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

for (const scenario of [
  { name: "measured edit after a snapshot", main: [counter(20, 10), edit("later", 11)], children: [], added: 22, coverage: "complete" },
  { name: "unmeasured edit after a snapshot", main: [counter(20, 10), call("later"), edit("later", 11, false)], children: [], added: 20, coverage: "partial" },
  { name: "child edit after the parent snapshot", main: [counter(20, 10)], children: [[edit("child", 11)]], added: 22, coverage: "complete" },
  { name: "child edit before the parent snapshot", main: [counter(20, 10)], children: [[edit("child", 9)]], added: 20, coverage: "complete" },
  { name: "child edit without cross-stream chronology", main: [counter(20, 10)], children: [[edit("child")]], added: 20, coverage: "partial" },
  { name: "counter reset", main: [counter(20, 10), counter(0, 11)], children: [], added: 20, coverage: "partial" },
  { name: "zero snapshot followed by measured edits", main: [counter(0, 10), edit("later", 11)], children: [], added: 2, coverage: "complete" },
  { name: "tied cross-stream timestamps", main: [counter(20, 10)], children: [[edit("child", 10)]], added: 20, coverage: "partial" },
  { name: "out-of-order edit timestamp", main: [counter(20, 10), edit("earlier", 9)], children: [], added: 20, coverage: "partial" },
  { name: "contradictory zero snapshot", main: [edit("earlier", 9), counter(0, 10)], children: [], added: 2, coverage: "partial" },
  { name: "later snapshot absorbs measured and unmeasured tails", main: [counter(20, 10), edit("tail", 11), call("missing"), edit("missing", 12, false), counter(25, 13)], children: [], added: 25, coverage: "complete" },
]) test(`Claude snapshot reconciliation: ${scenario.name}`, async () => {
  const session = await analyzeClaude(scenario.main, scenario.children);
  assert.equal(session.outcomes?.linesAdded, scenario.added);
  assert.equal(session.outcomes?.lineCoverage, scenario.coverage);
  const summary = summarizeOutcomes(Array.from({ length: 5 }, () => priced(session.outcomes)));
  assert.equal(summary.linesPerApiDollar.value, scenario.coverage === "complete" ? scenario.added / 2 : null);
});

test("repeated snapshots do not add covered patches or child totals, and child file order does not change chronology", () => {
  const collect = (childFirst: boolean) => {
    const collector = new OutcomeCollector(row());
    const main = () => { collector.observeClaude(edit("main", 1)); collector.observeClaude(counter(10, 10)); collector.observeClaude(counter(10, 10)); };
    const child = () => { collector.observeClaude(edit("child", 2), "child"); collector.observeClaude(counter(2, 5), "child"); collector.observeClaude(edit("tail", 11), "child"); };
    if (childFirst) { child(); main(); } else { main(); child(); }
    return collector.project();
  };
  const output = collect(false);
  assert.equal(output.linesAdded, 12); assert.equal(output.editOperations, 3); assert.equal(output.lineCoverage, "complete");
  assert.deepEqual(collect(true), output); privateOutput(output);
});

test("child-only snapshots reconcile their tails, while replayed results cannot make cumulative streams additive", () => {
  const collector = new OutcomeCollector(row());
  collector.observeClaude(counter(10, 10), "child"); collector.observeClaude(edit("tail", 11), "child");
  assert.equal(collector.project().linesAdded, 12); assert.equal(collector.project().lineCoverage, "complete");
  collector.observeClaude(edit("tail", 11), "sibling"); collector.observeClaude(counter(2, 12), "sibling");
  assert.equal(collector.project().linesAdded, 12); assert.equal(collector.project().lineCoverage, "partial");
  privateOutput(collector.project());
});

test("Claude UUID fallback is stream-local and distinct provider IDs never deduplicate by patch content", () => {
  const collector = new OutcomeCollector(row());
  const fallback = { ...edit("fallback", 1), message: { content: [{ type: "tool_result", content: secret }] } };
  collector.observeClaude(fallback); collector.observeClaude(fallback); collector.observeClaude(fallback, "child");
  collector.observeClaude(edit("first", 2)); collector.observeClaude(edit("second", 2));
  assert.equal(collector.project().editOperations, 4); assert.equal(collector.project().linesAdded, 8);
});

for (const scenario of [
  { name: "parent and child replay", main: [call("shared"), edit("shared", 1)], children: [[call("shared"), edit("shared", 1)]], operations: 1 },
  { name: "sibling replay", main: [], children: [[call("shared"), edit("shared", 1)], [call("shared"), edit("shared", 1)]], operations: 1 },
  { name: "distinct calls with identical content", main: [call("first"), edit("first", 1)], children: [[call("second"), edit("second", 1)]], operations: 2 },
]) test(`Claude session-wide result identity: ${scenario.name}`, async () => {
  const session = await analyzeClaude(scenario.main, scenario.children);
  assert.equal(session.tools["Edit"], scenario.operations);
  assert.equal(session.outcomes?.editOperations, scenario.operations);
  assert.equal(session.outcomes?.linesAdded, 2 * scenario.operations);
  assert.equal(session.outcomes?.lineCoverage, "complete");
});

test("Claude session-wide result identity also deduplicates Git and PR operations", () => {
  const collector = new OutcomeCollector(row());
  const result = { ...edit("operation", 1), toolUseResult: { gitOperation: { commit: { sha: "a".repeat(40), kind: "committed" }, push: {}, pr: { url: "https://github.com/example/synthetic/pull/1", action: "merged" } } } };
  for (const stream of ["main", "child-a", "child-b"]) collector.observeClaude(result, stream);
  assert.deepEqual(collector.project().operations, { commits: 1, pushes: 1, prsCreated: 0, prsEdited: 0, prsMerged: 1, prsClosed: 0 });
  privateOutput(collector.project());
});

function pr(collector: OutcomeCollector, number: number, action: string) {
  collector.observeClaude({ ...edit(`pr-${number}`, 1), toolUseResult: { gitOperation: { pr: { url: `https://github.com/example/synthetic/pull/${number}`, action, title: secret } } } });
}
for (const action of ["created", "merged"]) test(`PR allocation is withheld when the detail cap drops a ${action} association`, () => {
  const collector = new OutcomeCollector(row());
  for (let number = 1; number <= 3; number++) pr(collector, number, "merged");
  for (let branch = 0; branch < 125; branch++) collector.observeClaude({ gitBranch: `${secret}-${branch}` });
  // Losing branch enrichment inputs alone must not invalidate complete PR allocation.
  assert.equal(summarizeOutcomes([priced(collector.project(), 90)]).apiEquivalentPerMergedPr.value, 30);
  pr(collector, 4, action);
  const sessions = [priced(collector.project(), 90)];
  const summary = summarizeOutcomes(sessions);
  assert.equal(summary.apiEquivalentPerMergedPr.status, "incomplete-evidence");
  assert.equal(summary.apiEquivalentPerMergedPr.value, null);
  assert.equal(summary.apiEquivalentPerMergedPr.incompleteEvidenceSessions, 1);
  assert.match(outcomeReport(sessions), /incomplete-evidence/);
  privateOutput({ sessions, summary, report: outcomeReport(sessions) });
});

test("PR allocation reports incomplete evidence even when every PR detail was lost", () => {
  const collector = new OutcomeCollector(row());
  for (let branch = 0; branch < 128; branch++) collector.observeClaude({ gitBranch: `${secret}-${branch}` });
  pr(collector, 1, "merged");
  const summary = summarizeOutcomes([priced(collector.project(), 90)]);
  assert.equal(summary.apiEquivalentPerMergedPr.status, "incomplete-evidence");
  assert.equal(summary.apiEquivalentPerMergedPr.candidateSessions, 1);
  assert.equal(summary.apiEquivalentPerMergedPr.denominator, 0);
  privateOutput(summary);
});

test("coverage cohorts distinguish incomplete lines, missing measurements, and uninspected sessions", () => {
  const complete = new OutcomeCollector(row()); complete.observeClaude(edit("complete", 1));
  const partial = new OutcomeCollector(row()); partial.observeClaude(edit("partial", 1)); partial.observeClaude(call("missing")); partial.observeClaude(edit("missing", 2, false));
  const sessions = [priced(complete.project()), priced(partial.project()), priced(new OutcomeCollector(row()).project()), priced(undefined)];
  const summary = summarizeOutcomes(sessions);
  assert.deepEqual(summary.coverage.lines, { complete: 1, partial: 1, unavailable: 1 });
  assert.equal(summary.observedSessions, 3); assert.equal(summary.coverage.enrichment.git.off, 3);
  assert.equal(summary.lineMeasuredSessions, 2); assert.equal(summary.linesPerApiDollar.eligibleSessions, 1);
  assert.match(outcomeReport(sessions), /1 complete; 1 partial; 1 unavailable/);
  assert.match(outcomeReport(sessions), /1 uninspected/);
  privateOutput({ summary, report: outcomeReport(sessions) });
});

test("Codex mixed FileChange batches retain all valid file diffs regardless of missing-file position", () => {
  const valid = { unified_diff: `@@ -0,0 +1,2 @@\n+${secret}\n+second\n` };
  const missing = { type: "add", path: secret };
  const malformed = { unified_diff: `@@ -0,0 +1,3 @@\n+${secret}\n` };
  const observe = (collector: OutcomeCollector, changes: object, id: string) => collector.observeCodex({ type: "event_msg", payload: { type: "item_completed", item: { id, type: "FileChange", changes } } }, 1);
  const separate = new OutcomeCollector(row());
  [valid, missing, valid, malformed].forEach((change, index) => observe(separate, { [secret]: change }, String(index)));
  for (const entries of [[valid, missing, valid, malformed], [missing, valid, malformed, valid], [valid, valid, malformed, missing]]) {
    const batch = new OutcomeCollector(row());
    observe(batch, Object.fromEntries(entries.map((entry, index) => [`${secret}-${index}`, entry])), "batch");
    assert.equal(batch.project().linesAdded, separate.project().linesAdded);
    assert.equal(batch.project().linesAdded, 4);
    assert.equal(batch.project().lineCoverage, "partial");
    privateOutput(batch.project());
  }
  const unavailable = new OutcomeCollector(row()); observe(unavailable, { a: missing, b: malformed }, "missing");
  assert.equal(unavailable.project().linesAdded, null); assert.equal(unavailable.project().lineCoverage, "unavailable");
});

test("terminal coverage distinguishes off, failed, and limited enrichment without leaking subprocess errors", async () => {
  const render = async (mode: "off" | "failed" | "limited") => {
    const collector = new OutcomeCollector({ ...row(), branch: secret, root_path: `/synthetic/${secret}` });
    for (let number = 1; number <= 25; number++) pr(collector, number, "created");
    collector.observeClaude(edit("measured", 1)); collector.observeClaude(call("missing")); collector.observeClaude(edit("missing", 2, false));
    const run: OutcomeCommand = async (_command, args) => mode === "failed" ? null : args[0] === "auth" ? "" : secret;
    const output = await collector.finish(new OutcomeEnricher({ outcomesGit: mode !== "off", outcomesGithub: mode !== "off" }, run), at(0), at(10));
    const report = outcomeReport([priced(output)]); privateOutput(report); return report;
  };
  const off = await render("off"), failed = await render("failed"), limited = await render("limited");
  assert.notEqual(off, failed); assert.notEqual(failed, limited);
  assert.match(off, /Local Git:.*1 off/); assert.match(failed, /Local Git:.*1 unavailable/);
  assert.match(limited, /GitHub:.*1 limited/);
  assert.match(off, /0 complete.*1 partial.*0 unavailable/);
  assert.match(off, /lower bound/);
  const truncated = new OutcomeCollector(row());
  for (let number = 1; number <= 129; number++) pr(truncated, number, "created");
  assert.match(outcomeReport([priced(truncated.project())]), /1 sessions reached evidence limits/);
});

test("failed local Git report keeps actual subprocess error paths private", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outcomes-error-"));
  try {
    // git -C emits the missing directory in stderr; the real command wrapper
    // must discard it while the report still distinguishes failure from off.
    const collector = new OutcomeCollector({ ...row(), branch: "synthetic-branch", root_path: join(directory, secret) });
    const off = outcomeReport([priced(collector.project())]);
    const output = await collector.finish(new OutcomeEnricher({ outcomesGit: true }), at(0), at(10));
    assert.equal(output.enrichment.git, "unavailable");
    const failed = outcomeReport([priced(output)]);
    assert.notEqual(failed, off); assert.match(failed, /Local Git: 1 unavailable/);
    privateOutput({ output, failed }); assert.ok(!failed.includes(directory));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
