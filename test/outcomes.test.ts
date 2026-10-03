import assert from "node:assert/strict";
import test from "node:test";
import { OutcomeCollector, countUnifiedDiff, pullRequestTarget } from "../src/metrics/outcomes.ts";
import { OutcomeEnricher, type OutcomeCommand } from "../src/metrics/outcomes-enrichment.ts";
import { summarizeOutcomes } from "../src/metrics/outcomes-summary.js";
import { analyzeOptionsFrom } from "../src/options.ts";
import type { SessionAnalytics, SessionDatabaseRow } from "../src/types.ts";

const secret = "outcome-content-sentinel";
const rawSha = "abcdef1234567890abcdef1234567890abcdef12";
const otherSha = "1234567890abcdef1234567890abcdef12345678";
const prUrl = "https://github.com/secret-owner/secret-repository/pull/987654321";
const start = "2026-09-01T12:00:00.000Z", end = "2026-09-01T13:00:00.000Z";
function row(patch: Partial<SessionDatabaseRow> = {}): SessionDatabaseRow {
  return { agent_type: "claude", branch: null, conductor_session_id: "raw-private-session", created_at: start,
    database_model: null, default_branch: "main", is_hidden: 0, provider_session_id: "raw-provider-id",
    repository_id: "repo-public-key", repository_name: "Demo", repository_remote: "https://github.com/secret-owner/secret-repository.git",
    root_path: "/synthetic/private-root", status: "idle", title: secret, updated_at: end,
    workspace_name: secret, workspace_path: "/synthetic/private-workspace", ...patch };
}
function result(id: string, toolUseResult: unknown, error = false) {
  return { type: "user", uuid: `uuid-${id}`, toolUseResult, message: { content: [{ type: "tool_result", tool_use_id: id, is_error: error, content: secret }] } };
}
function prOperation(collector: OutcomeCollector, number: number, action: string, id = `${number}-${action}`) {
  collector.observeClaude(result(id, { gitOperation: { pr: { number, url: `https://github.com/example/demo/pull/${number}`, action, title: secret } } }));
}
function session(collector: OutcomeCollector, price = 6): SessionAnalytics {
  return { outcomes: collector.project(), cost: { totalUsd: price }, costBasis: "api-list-price-equivalent", costComplete: true,
    pricedTokenCoverage: 1 } as SessionAnalytics;
}
function privateOutput(value: unknown) {
  const serialized = JSON.stringify(value);
  for (const sentinel of [secret, rawSha, otherSha, "secret-owner", "secret-repository", "987654321", "raw-private-session", "raw-provider-id", "private-root", "private-workspace", "private-branch"]) assert.ok(!serialized.includes(sentinel), `Leaked sentinel: ${sentinel}`);
}

test("Claude uses nested structured operation results, deduplicates tool results and PR links, and never interprets text", () => {
  const collector = new OutcomeCollector(row());
  const commit = result("commit-id", { gitOperation: { commit: { sha: rawSha, branch: "private-branch", kind: "committed" }, push: { branch: "private-branch" } }, stdout: secret });
  collector.observeClaude(commit); collector.observeClaude(commit);
  collector.observeClaude(result("bad", { gitOperation: { commit: { sha: otherSha } } }, true));
  collector.observeClaude(result("interrupted", { interrupted: true, gitOperation: { commit: { sha: otherSha } } }));
  collector.observeClaude(result("timeout", { timedOutAfterMs: 20, gitOperation: { commit: { sha: otherSha } } }));
  const link = { type: "pr-link", prUrl, prNumber: 987654321, prRepository: "secret-owner/secret-repository", title: secret };
  collector.observeClaude(link); collector.observeClaude(link);
  for (const action of ["created", "edited", "merged", "closed"]) collector.observeClaude(result(action, { gitOperation: { pr: { url: prUrl, action, number: 987654321 } } }));
  collector.observeClaude({ type: "assistant", message: { content: [{ type: "text", text: `git commit ${otherSha}; merged ${prUrl}` }] } });
  const output = collector.project();
  assert.deepEqual(output.operations, { commits: 1, pushes: 1, prsCreated: 1, prsEdited: 1, prsMerged: 1, prsClosed: 1 });
  assert.equal(output.links.filter((link) => link.kind === "commit").length, 1);
  const prs = output.links.filter((link) => link.kind === "pull-request");
  assert.equal(prs.length, 1); assert.equal(prs[0]?.state, "merged"); assert.equal(prs[0]?.created, true);
  assert.equal(prs[0]?.confidence, "strong"); assert.deepEqual(prs[0]?.sources, ["claude-git-operation", "claude-pr-link"]);
  privateOutput(output);
});

test("starting commits and Conductor workspace metadata remain context, even with a merged workspace status", () => {
  const collector = new OutcomeCollector(row({ outcome_workspace_id: "raw-workspace-id", outcome_pr_present: 1, outcome_workspace_status: "merged", outcome_archive_commit: rawSha, branch: "private-branch" }));
  collector.observeCodex({ type: "session_meta", payload: { git: { branch: "private-branch", commit_hash: otherSha, repository_url: prUrl } } }, 1);
  const output = collector.project();
  assert.ok(output.links.length >= 3); assert.ok(output.links.every((link) => link.role === "context" && link.confidence === "weak"));
  const summary = summarizeOutcomes([session(collector)]);
  assert.equal(summary.commitSessions, 0); assert.equal(summary.prSessions, 0); assert.equal(summary.pullRequests.merged, 0);
  assert.equal(summary.contextOnlySessions, 1); privateOutput({ output, summary });
});

test("Claude counter resets and conflicting child totals retain a partial high-water lower bound", () => {
  const collector = new OutcomeCollector(row());
  const patch = result("edit", { structuredPatch: [{ oldLines: 2, newLines: 3, lines: [" same", `-${secret}`, `+${secret}`, "+another"] }], filePath: secret });
  collector.observeClaude(patch); collector.observeClaude(patch);
  assert.equal(collector.project().linesAdded, 2); assert.equal(collector.project().linesRemoved, 1);
  collector.observeClaude({ type: "cost-state", totalLinesAdded: 10, totalLinesRemoved: 5, totalCostUSD: 999, content: secret });
  collector.observeClaude({ type: "cost-state", totalLinesAdded: 8, totalLinesRemoved: 4 });
  collector.observeClaude({ type: "cost-state", totalLinesAdded: 10, totalLinesRemoved: 5 });
  collector.observeClaude({ type: "cost-state", totalLinesAdded: 100, totalLinesRemoved: 40 }, "private-subagent-path");
  collector.observeClaude(patch, "private-subagent-path");
  const output = collector.project();
  assert.equal(output.linesAdded, 100); assert.equal(output.linesRemoved, 40); assert.equal(output.editOperations, 1);
  assert.equal(output.lineSource, "claude-cost-state"); assert.equal(output.lineCoverage, "partial"); privateOutput(output);
});

test("line measurements distinguish missing, partial, empty, malformed, failed, and repeated FileChange evidence", () => {
  assert.equal(countUnifiedDiff(`--- ${secret}\n+++ ${secret}\n@@ -1,2 +1,3 @@\n same\n-old\n+new\n+++content\n\\ No newline at end of file\n`)?.added, 2);
  assert.equal(countUnifiedDiff("@@ -1,2 +1,1 @@\n-old\n+new"), null);
  assert.equal(countUnifiedDiff("@@ -1 +1 @@\n-old\n+new\n+extra"), null);
  assert.equal(countUnifiedDiff("+++ header\n--- header"), null);
  assert.deepEqual(countUnifiedDiff("@@ -0,0 +1,2 @@\n+a\n+b\n"), { added: 2, removed: 0 });
  const collector = new OutcomeCollector(row({ agent_type: "codex" }));
  assert.equal(collector.project().linesAdded, null);
  const change = { type: "event_msg", payload: { type: "item_completed", item: { type: "FileChange", id: "edit-id", status: "completed", changes: { [secret]: { type: "update", unified_diff: `@@ -1 +1,2 @@\n-${secret}\n+one\n+two\n` } } } } };
  collector.observeCodex(change, 1); collector.observeCodex(change, 2);
  assert.equal(collector.project().editOperations, 1); assert.equal(collector.project().linesAdded, 2);
  for (const status of ["failed", "declined", secret]) collector.observeCodex({ ...change, payload: { ...change.payload, item: { ...change.payload.item, id: status, status } } }, 3);
  assert.equal(collector.project().editOperations, 1);
  collector.observeCodex({ type: "event_msg", payload: { type: "item_completed", item: { type: "FileChange", id: "missing-diff", changes: { [secret]: { type: "delete" } } } } }, 4);
  assert.equal(collector.project().lineCoverage, "partial"); assert.equal(collector.project().lineSource, "codex-file-change");
  const cursor = new OutcomeCollector(row({ agent_type: "cursor" }));
  cursor.observeCursor({ totalLinesAdded: -1, totalLinesRemoved: 3, text: secret }); assert.equal(cursor.project().linesAdded, null);
  cursor.observeCursor({ totalLinesAdded: 0, totalLinesRemoved: 0, text: secret }); assert.equal(cursor.project().linesAdded, 0); assert.equal(cursor.project().editsObserved, false);
  privateOutput({ codex: collector.project(), cursor: cursor.project() });
});

test("PR identity parser rejects foreign hosts, credentials, queries, malformed refs, and unsafe numbers", () => {
  assert.deepEqual(pullRequestTarget(prUrl), { repository: "secret-owner/secret-repository", number: 987654321 });
  assert.deepEqual(pullRequestTarget(undefined, "Example/Demo", 4), { repository: "example/demo", number: 4 });
  for (const url of ["http://github.com/example/demo/pull/1", "https://evil.example/example/demo/pull/1", "https://user:pass@github.com/example/demo/pull/1", `${prUrl}?token=${secret}`, `${prUrl}#${secret}`, "https://github.com/example/demo/pull/0", "https://github.com/example/demo/pull/9007199254740992"]) assert.equal(pullRequestTarget(url), null);
  assert.equal(pullRequestTarget(undefined, "../secret", 2), null);
});

test("enrichment is completely inert by default; boolean opt-in requires 1 and CLI flags take precedence", async () => {
  let calls = 0;
  const run: OutcomeCommand = async () => { calls += 1; return null; };
  const collector = new OutcomeCollector(row({ branch: "private-branch" })); collector.observeClaude({ type: "pr-link", prUrl });
  const output = await collector.finish(new OutcomeEnricher({}, run), start, end);
  assert.equal(calls, 0); assert.deepEqual(output.enrichment, { git: "off", github: "off" });
  assert.equal(analyzeOptionsFrom([], { SESSION_ANALYTICS_OUTCOMES_GITHUB: "true" }).outcomesGithub, false);
  assert.equal(analyzeOptionsFrom([], { SESSION_ANALYTICS_OUTCOMES_GITHUB: "1" }).outcomesGithub, true);
  const options = analyzeOptionsFrom(["--outcomes-git", "--no-outcomes-github"], { SESSION_ANALYTICS_OUTCOMES_GITHUB: "1" });
  assert.equal(options.outcomesGit, true); assert.equal(options.outcomesGithub, false); privateOutput(output);
});

test("local Git uses only evidenced local branches and exact session windows; starting commits are excluded", async () => {
  const commands: string[][] = [];
  const run: OutcomeCommand = async (command, args, timeout) => {
    assert.equal(command, "git"); assert.ok(timeout <= 3000); commands.push(args);
    return `${rawSha}\0${Date.parse(start) / 1000}\0Claude <${secret}@example.invalid>\x1e\n${otherSha}\0${Date.parse(start) / 1000 + 30}\0Codex <${secret}@example.invalid>\x1e\n${"f".repeat(40)}\0${Date.parse(end) / 1000 + 1}\0\x1e`;
  };
  const collector = new OutcomeCollector(row());
  collector.observeCodex({ type: "session_meta", payload: { git: { branch: "private-branch", commit_hash: rawSha } } }, 1);
  const output = await collector.finish(new OutcomeEnricher({ outcomesGit: true }, run), start, end);
  assert.equal(output.enrichment.git, "matched"); assert.equal(output.agentCoauthoredCommits, 1);
  assert.equal(output.links.filter((link) => link.kind === "commit" && link.role === "outcome").length, 1);
  assert.equal(output.links.find((link) => link.role === "outcome")?.confidence, "medium");
  assert.ok(commands[0]?.includes("refs/heads/private-branch")); assert.ok(commands[0]?.includes("--max-count=201"));
  privateOutput(output);
  const invalid = new OutcomeCollector(row({ branch: "--exec=private-branch" }));
  assert.equal((await invalid.finish(new OutcomeEnricher({ outcomesGit: true }, run), start, end)).enrichment.git, "not-applicable");
  assert.equal(commands.length, 1);
});

test("GitHub queries only evidenced PR coordinates, caches across sessions, and emits only state and duration", async () => {
  const commands: { command: string; args: string[] }[] = [];
  const run: OutcomeCommand = async (command, args) => {
    commands.push({ command, args });
    return args[0] === "auth" ? "" : JSON.stringify({ state: "MERGED", createdAt: start, mergedAt: end, title: secret, body: secret, author: { email: secret } });
  };
  const enricher = new OutcomeEnricher({ outcomesGithub: true }, run);
  for (let i = 0; i < 2; i++) {
    const collector = new OutcomeCollector(row()); collector.observeClaude({ type: "pr-link", prUrl });
    const output = await collector.finish(enricher, start, end);
    assert.equal(output.enrichment.github, "matched"); assert.equal(output.links[0]?.timeToMergeMilliseconds, 3_600_000); privateOutput(output);
  }
  assert.equal(commands.length, 2); assert.equal(commands[1]?.command, "gh");
  assert.deepEqual(commands[1]?.args, ["pr", "view", "987654321", "--repo", "https://github.com/secret-owner/secret-repository", "--json", "state,createdAt,mergedAt"]);
});

test("enrichment degrades without raw errors and obeys repo filters, malformed-response handling, and scan query budgets", async () => {
  const noAccess: OutcomeCommand = async () => null;
  const collector = new OutcomeCollector(row({ branch: "private-branch" })); collector.observeClaude({ type: "pr-link", prUrl });
  const output = await collector.finish(new OutcomeEnricher({ outcomesGit: true, outcomesGithub: true }, noAccess), start, end);
  assert.deepEqual(output.enrichment, { git: "unavailable", github: "unavailable" }); privateOutput(output);
  let calls = 0;
  const invalid: OutcomeCommand = async (_command, args) => { calls += 1; return args[0] === "auth" ? "" : secret; };
  const filtered = await collector.finish(new OutcomeEnricher({ outcomesGit: true, outcomesGithub: true, repositoryName: "Different" }, invalid), start, end);
  assert.equal(calls, 0); assert.equal(filtered.enrichment.github, "not-applicable");
  const enricher = new OutcomeEnricher({ outcomesGithub: true }, invalid);
  const many = new OutcomeCollector(row());
  for (let number = 1; number <= 25; number++) prOperation(many, number, "created");
  const limited = await many.finish(enricher, start, end);
  assert.equal(calls, 21); assert.equal(limited.enrichment.github, "limited"); privateOutput(limited);
});

test("artifact aggregation deduplicates PRs across sessions, guards ratios, separates pricing bases, and allocates open PR shares", () => {
  const shared = new OutcomeCollector(row());
  prOperation(shared, 1, "created"); prOperation(shared, 1, "merged"); prOperation(shared, 2, "created");
  shared.observeClaude({ type: "cost-state", totalLinesAdded: 20, totalLinesRemoved: 4 });
  const sessions = [session(shared), session(shared)];
  let summary = summarizeOutcomes(sessions);
  assert.equal(summary.pullRequests.linked, 2); assert.equal(summary.pullRequests.created, 2); assert.equal(summary.pullRequests.merged, 1);
  assert.equal(summary.apiEquivalentPerMergedPr.numerator, 6); assert.equal(summary.apiEquivalentPerMergedPr.value, null);
  assert.equal(summary.apiEquivalentPerMergedPr.status, "insufficient-activity"); assert.equal(summary.unlinkedApiEquivalentUsd, 12);
  for (let id = 3; id <= 4; id++) { const collector = new OutcomeCollector(row()); prOperation(collector, id, "merged"); sessions.push(session(collector)); }
  summary = summarizeOutcomes(sessions);
  assert.equal(summary.apiEquivalentPerMergedPr.value, 6); // (3 + 3 + 6 + 6) / 3 distinct merged PRs
  sessions[2]!.costComplete = false;
  assert.equal(summarizeOutcomes(sessions).apiEquivalentPerMergedPr.status, "incomplete-pricing");
  const cursor = session(shared, 900); cursor.costBasis = "provider-reported";
  const withCursor = summarizeOutcomes([...sessions, cursor]);
  assert.equal(withCursor.apiEquivalentValueUsd, summary.apiEquivalentValueUsd);
  assert.equal(withCursor.linesPerApiDollar.eligibleSessions, 2);
  const complete = Array.from({ length: 5 }, () => session(shared, 2));
  assert.equal(summarizeOutcomes(complete).linesPerApiDollar.value, 12);
  const partial = session(shared, 100); partial.outcomes!.lineCoverage = "partial";
  assert.equal(summarizeOutcomes([...complete, partial]).linesPerApiDollar.value, 12);
  assert.equal(summarizeOutcomes([...complete, partial]).linesPerApiDollar.eligibleSessions, 5);
  assert.equal(summarizeOutcomes(complete).commitSessionRate.value, 0);
  assert.equal(summarizeOutcomes([]).commitSessionRate.value, null);
  privateOutput({ summary, withCursor });
});

test("unidentified PR operations do not become unique PRs and bounded link retention is visible", () => {
  const collector = new OutcomeCollector(row());
  collector.observeClaude(result("missing-id", { gitOperation: { pr: { action: "merged", number: 7 } } }));
  const summary = summarizeOutcomes([session(collector)]);
  assert.equal(summary.prSessions, 1); assert.equal(summary.pullRequests.merged, 0); assert.equal(summary.pullRequests.unidentifiedMergedOperations, 1);
  for (let number = 1; number <= 140; number++) prOperation(collector, number, "created");
  assert.ok(collector.project().links.length <= 128 && collector.project().links.length > 120); assert.equal(collector.project().truncated, true); privateOutput(collector.project());
});

test("PR operations missing URLs resolve only against unambiguous locally evidenced coordinates, in either record order", () => {
  const collector = new OutcomeCollector(row());
  collector.observeClaude(result("merge", { gitOperation: { pr: { action: "merged", number: 7 } } }));
  collector.observeClaude({ type: "pr-link", prRepository: "example/demo", prNumber: 7 });
  const summary = summarizeOutcomes([session(collector)]);
  assert.equal(summary.pullRequests.merged, 1); assert.equal(summary.pullRequests.unidentifiedMergedOperations, 0);
  assert.equal(collector.project().links.filter((link) => link.kind === "pull-request").length, 1);
  const ambiguous = new OutcomeCollector(row());
  ambiguous.observeClaude(result("merge", { gitOperation: { pr: { action: "merged", number: 7 } } }));
  ambiguous.observeClaude({ type: "pr-link", prRepository: "example/first", prNumber: 7 });
  ambiguous.observeClaude({ type: "pr-link", prRepository: "example/second", prNumber: 7 });
  assert.equal(summarizeOutcomes([session(ambiguous)]).pullRequests.merged, 0);
  privateOutput(collector.project()); privateOutput(ambiguous.project());
});

test("Git results and per-scan query counts are capped and missing/invalid windows never fall back to HEAD", async () => {
  const many: OutcomeCommand = async () => Array.from({ length: 201 }, (_, index) => `${(index + 1).toString(16).padStart(40, "0")}\0${Date.parse(start) / 1000 + 20}\0\x1e`).join("\n");
  const collector = new OutcomeCollector(row({ branch: "fixture-branch" }));
  const capped = await collector.finish(new OutcomeEnricher({ outcomesGit: true }, many), start, end);
  assert.equal(capped.enrichment.git, "limited"); assert.equal(capped.truncated, true); assert.ok(capped.links.length <= 128);
  let queries = 0;
  const empty: OutcomeCommand = async () => { queries += 1; return ""; };
  const enricher = new OutcomeEnricher({ outcomesGit: true }, empty);
  for (let index = 0; index < 100; index++) await new OutcomeCollector(row({ branch: "fixture-branch" })).finish(enricher, start, end);
  assert.equal((await collector.finish(enricher, start, end)).enrichment.git, "limited"); assert.equal(queries, 100);
  const fresh = new OutcomeEnricher({ outcomesGit: true }, empty);
  for (const [from, to] of [[null, null], [end, start], [start, "2026-10-01T12:00:00Z"], ["bad date", end]]) {
    assert.equal((await collector.finish(fresh, from ?? null, to ?? null)).enrichment.git, "not-applicable");
  }
  assert.equal(queries, 100); privateOutput(capped);
});
