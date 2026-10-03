import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { redactExcerpt } from "../src/insights/redact.ts";
import { invokeReviewAgent, projectAssessment } from "../src/insights/review-agent.ts";
import { prepareReview } from "../src/insights/review-context.ts";
import { captureReviewSource, verifyReviewSource } from "../src/insights/review-source.ts";
import { buildInsights } from "../src/insights/engine.ts";
import { context, createInsightsFixture, session, sessions, setUtcBoundaryStarts } from "./insights-fixtures.ts";
import type { InsightsReport, ReviewPreview } from "../src/types.ts";

const bin = resolve(import.meta.dirname, "../bin/session-analytics.ts");
const run = (args: string[], env: NodeJS.ProcessEnv = process.env) => spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", env, timeout: 30_000, maxBuffer: 2_000_000 });
async function fakeCli(directory: string, name: "claude" | "codex", body: string): Promise<void> {
  const path = join(directory, name);
  await writeFile(path, `#!${process.execPath}\n${body}\n`);
  await chmod(path, 0o755);
}

test("working review targets fail closed in full CLI dry-run and send before invoking PATH agents", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-working-"));
  try {
    const fixture = await createInsightsFixture(root), marker = join(root, "invoked");
    const first = JSON.parse((await readFile(fixture.source, "utf8")).split("\n")[0]!);
    const database = new DatabaseSync(fixture.options.databasePath!);
    database.exec(`CREATE TABLE repos (id TEXT, name TEXT, root_path TEXT, remote_url TEXT, default_branch TEXT, hidden INTEGER);
      CREATE TABLE workspaces (id TEXT, repository_id TEXT, workspace_name TEXT, workspace_path TEXT, branch TEXT);
      CREATE TABLE sessions (id TEXT, status TEXT, agent_type TEXT, title TEXT, created_at TEXT, updated_at TEXT, claude_session_id TEXT, model TEXT, is_hidden INTEGER, workspace_id TEXT);`);
    database.prepare("INSERT INTO repos VALUES ('repo', 'synthetic-project', ?, '', '', 0)").run(first.cwd);
    database.prepare("INSERT INTO workspaces VALUES ('workspace', 'repo', '', ?, '')").run(first.cwd);
    database.prepare("INSERT INTO sessions VALUES ('synthetic-working', 'working', 'claude', 'secret-title', ?, ?, ?, 'claude-premium', 0, 'workspace')").run(first.timestamp, first.timestamp, first.sessionId);
    database.close();
    const key = createHash("sha256").update("synthetic-working").digest("hex").slice(0, 12);
    await fakeCli(root, "claude", `require('node:fs').writeFileSync(process.env.REVIEW_TEST_CAPTURE, 'invoked'); process.stdin.resume(); console.log('{}');`);
    const env = { ...process.env, PATH: `${root}:${process.env["PATH"]}`, REVIEW_TEST_CAPTURE: marker };
    for (const send of [[], ["--send-content"]]) {
      const result = run(["review", "--session", key, "--via", "claude", "--json", ...fixture.flags, ...send], env);
      assert.equal(result.status, 2, result.stdout);
      assert.doesNotMatch(result.stdout + result.stderr, /secret-title|content-is-not-returned|synthetic-working/);
      await assert.rejects(stat(marker), { code: "ENOENT" });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("malformed enum types and native envelopes become primitive unknown labels through review JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-enum-types-"));
  try {
    const fixture = await createInsightsFixture(root);
    const binaries = join(root, "bin"); await mkdir(binaries);
    const fallback = { assessment: "unknown", confidence: "low", suggestion: "none" };
    const valid = { assessment: "expected", confidence: "high", suggestion: "check-context" };
    const invalid = [
      { assessment: ["expected"], confidence: ["low"], suggestion: ["none"] },
      { ...valid, assessment: [["expected"]] }, { ...valid, confidence: null },
      { ...valid, suggestion: { value: "none", content: "secret-agent-output" } },
    ];
    for (const value of invalid) assert.deepEqual(projectAssessment(value), fallback);
    for (const [via, envelope] of [
      ["claude", { type: "result", structured_output: invalid[0] }],
      ["claude", { type: "result", structured_output: invalid[2] }],
      ["claude", { type: "result", structured_output: invalid[3] }],
      ["claude", { type: "result", structured_output: [valid], result: "secret-agent-output" }],
      ["claude", { type: "result", structured_output: null, result: "secret-agent-output" }],
      ["claude", { type: "result", structured_output: null, result: JSON.stringify(valid) }],
      ["codex", { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(invalid[1]) } }],
      ["codex", { type: "item.completed", item: [valid] }],
    ] as const) {
      await fakeCli(binaries, via, `process.stdin.resume(); process.stdin.on('end', () => console.log(${JSON.stringify(JSON.stringify(envelope))}));`);
      const result = run(["review", "--session", fixture.sessionKey, "--via", via, "--send-content", "--json", ...fixture.flags], { ...process.env, PATH: `${binaries}:${process.env["PATH"]}` });
      assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout).result, fallback);
      assert.doesNotMatch(result.stdout, /secret-agent-output|content-is-not-returned/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("repository flags authorize review only for contributing sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-contributors-"));
  try {
    const fixture = await createInsightsFixture(root);
    await writeFile(fixture.source, (await readFile(fixture.source, "utf8")).replaceAll('"model":"claude-premium"', '"model":"unpriced-model"'));
    await writeFile(fixture.config, JSON.stringify({ disabledRules: ["session-outlier", "cache-waste", "compaction-heavy", "subagent-share", "long-context", "unused-skills", "unused-mcp", "idle-cache", "time-pattern"] }));
    const output = run(["review", "--session", fixture.sessionKey, "--via", "claude", "--send-content", "--json", ...fixture.flags], { ...process.env, PATH: root });
    assert.equal(output.status, 0, output.stderr);
    assert.equal(JSON.parse(output.stdout).preview.promptBytes, 0);
    assert.deepEqual(JSON.parse(output.stdout).preview.flaggedRules, []);
    assert.equal(JSON.parse(output.stdout).result, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("review revalidates source identity and version before preparing excerpts or sending", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-source-stability-"));
  try {
    const fixture = await createInsightsFixture(root), source = await captureReviewSource(fixture.source, "claude");
    const content = await readFile(fixture.source, "utf8"), s = session(1);
    const cards = buildInsights(sessions(5), context(), "2026-10-01T00:00:00Z").items;
    // Same-length identity replacement still changes inode metadata / source identity.
    await writeFile(fixture.source, content.replaceAll("11111111-1111-4111-8111-111111111111", "99999999-1111-4111-8111-111111111111"));
    await assert.rejects(prepareReview(fixture.source, s, cards, "claude", 200_000, source), /changed|identity/);
    await writeFile(fixture.source, content);
    const current = await captureReviewSource(fixture.source, "claude");
    await writeFile(fixture.source, content + '{"type":"system","content":"secret-new-tail"}\n');
    await assert.rejects(verifyReviewSource(fixture.source, current), /changed/);
    s.transcript.snapshotWhileWorking = true;
    await assert.rejects(prepareReview(join(root, "absent"), s, cards, "claude", 200_000, current), /ineligible/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("insights CLI returns content-free cards and applies shared source, config and date options", async () => {
  const root = await mkdtemp(join(tmpdir(), "insights-command-"));
  try {
    const fixture = await createInsightsFixture(root);
    const result = run(["insights", "--json", ...fixture.flags]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as InsightsReport;
    assert.ok(report.items.length >= 6); assert.equal(report.coverage.length, 10);
    assert.equal(report.schemaVersion, 2);
    assert.deepEqual(Object.keys(report).sort(), ["schemaVersion", "generatedAt", "rateCardEffectiveDate", "thresholds", "groups", "items", "coverage", "warnings", "evidenceCoverage"].sort());
    assert.ok(report.groups.length > 0 && report.groups.length <= 10);
    assert.deepEqual(report.groups.flatMap((group) => group.itemIds).sort(), report.items.map((item) => item.id).sort());
    assert.ok(report.groups.every((group) => group.affected.sessions <= group.coverage.totalSessions && group.affected.repositories <= group.coverage.totalRepositories));
    assert.doesNotMatch(result.stdout, /secret-|content-is-not-returned|private-branch|11111111-1111/);
    const text = run(["insights", ...fixture.flags]); assert.equal(text.status, 0, text.stderr); assert.match(text.stdout, /not an invoice/); assert.match(text.stdout, /Rule coverage/);
    assert.match(text.stdout, /distinct insights/); assert.match(text.stdout, /Next-tier-down model price scenarios/);
    const scopes = run(["insights", "--rule", "model-pricing", "--all-scopes", ...fixture.flags]);
    assert.equal(scopes.status, 0, scopes.stderr); assert.match(scopes.stdout, /Tokens moved to a target tier/);
    assert.match(scopes.stdout, /claude-premium → claude-small/);
    const one = run(["insights", "--json", "--rule", "model-pricing", ...fixture.flags]);
    assert.equal(one.status, 0, one.stderr);
    assert.equal(JSON.parse(one.stdout).groups.length, 1);
    assert.ok(JSON.parse(one.stdout).items.every((item: { rule: string }) => item.rule === "model-pricing"));
    const filtered = run(["insights", "--json", ...fixture.flags, "--from", "2026-09-06"]);
    assert.equal(filtered.status, 0, filtered.stderr); assert.equal((JSON.parse(filtered.stdout) as InsightsReport).coverage[0]!.totalSessions, 1);
    for (const args of [["--from", "2026-02-30"], ["--unknown", "secret-value"], ["--json", "--json"], ["--insights-config"], ["--rule", "secret-value"]]) {
      const invalid = run(["insights", ...fixture.flags, ...args]); assert.equal(invalid.status, 2); assert.doesNotMatch(invalid.stderr, /secret-value|\.json|\/Users\//);
    }
    const help = run(["insights", "--help"]); assert.equal(help.status, 0); assert.match(help.stdout, /--insights-config/);
    await setUtcBoundaryStarts(fixture.source);
    const utc = run(["insights", "--json", ...fixture.flags, "--from", "2026-09-02", "--through", "2026-09-02"]);
    assert.equal(utc.status, 0, utc.stderr);
    assert.ok(JSON.parse(utc.stdout).coverage.every((row: { totalSessions: number }) => row.totalSessions === 4));
    assert.match(JSON.parse(utc.stdout).warnings.join(" "), /1.*invalid or missing.*start/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("redaction removes common secrets, links, identifiers, paths and code without passing tool content through", () => {
  const source = 'Safe prose api_key="secret-api-value" Bearer secret-bearer sk-abcdefgh12345678 ghp_abcdefgh12345678 person@example.test https://private.example.test/x /secret/files.txt C:\\secret\\file.ts ../private/file.ts source/private.ts 11111111-1111-4111-8111-111111111111 `secret-command` ```secret-code``` private-project';
  const result = redactExcerpt(source, ["private-project"]);
  assert.match(result.text, /Safe prose/);
  assert.doesNotMatch(result.text, /secret-|abcdefgh|example\.test|files\.txt|file\.ts|11111111|private-project/);
  assert.ok(result.counts.credentials >= 4); assert.equal(result.counts.emails, 1); assert.ok(result.counts.paths >= 4); assert.equal(result.counts.codeBlocks, 2);
  assert.equal(projectAssessment({ assessment: "worth-review", confidence: "low", suggestion: "check-cache", content: "secret-result" }).assessment, "worth-review");
  assert.doesNotMatch(JSON.stringify(projectAssessment({ assessment: "worth-review", confidence: "low", suggestion: "check-cache", content: "secret-result" })), /secret-result/);
  assert.equal(projectAssessment({ assessment: "invented" }).assessment, "unknown");
});

test("review CLI dry-run never invokes PATH agents, and explicit sends use bounded redacted stdin for both CLIs", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-command-"));
  try {
    const fixture = await createInsightsFixture(root), capture = join(root, "captured.json");
    const body = `const fs = require('node:fs'); let prompt = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => prompt += chunk); process.stdin.on('end', () => { fs.writeFileSync(process.env.REVIEW_TEST_CAPTURE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), prompt })); process.stdout.write(JSON.stringify({assessment: 'worth-review', confidence: 'low', suggestion: 'check-context', private: 'secret-agent-output'})); });`;
    const binaries = join(root, "bin"); await mkdir(binaries);
    await fakeCli(binaries, "claude", body); await fakeCli(binaries, "codex", body);
    const env = { ...process.env, PATH: `${binaries}:${process.env["PATH"]}`, REVIEW_TEST_CAPTURE: capture, SESSION_ANALYTICS_SEND_CONTENT: "true" };
    const base = ["review", "--session", fixture.sessionKey, "--via", "claude", "--json", ...fixture.flags];
    const dry = run(base, env);
    assert.equal(dry.status, 0, dry.stderr);
    const preview = (JSON.parse(dry.stdout) as { preview: ReviewPreview }).preview;
    assert.equal(preview.mode, "dry-run"); assert.equal(preview.privacyTier, "P3"); assert.ok(preview.spans <= 3 && preview.spans > 0); assert.ok(preview.excerpts <= 12 && preview.excerpts > 0); assert.ok(preview.promptBytes < 60_000); assert.ok(preview.redactions.credentials > 0); assert.ok(preview.omittedBlocks > 0);
    await assert.rejects(stat(capture), { code: "ENOENT" });
    assert.doesNotMatch(dry.stdout, /secret-|content-is-not-returned|synthetic-private-branch|private\.example|person@example|\/projects\//);
    for (const via of ["claude", "codex"]) {
      const result = run(["review", "--session", fixture.sessionKey, "--via", via, "--send-content", "--json", ...fixture.flags], env);
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout) as { preview: ReviewPreview; result: { assessment: string } };
      assert.equal(output.preview.mode, "sent"); assert.equal(output.result.assessment, "worth-review");
      assert.doesNotMatch(result.stdout, /secret-|content-is-not-returned/);
      const sent = JSON.parse(await readFile(capture, "utf8")) as { args: string[]; prompt: string; cwd: string };
      assert.match(sent.prompt, /UNTRUSTED DATA/); assert.match(sent.prompt, /unknown/);
      assert.match(sent.prompt, /content-is-not-returned/); // P3 prose is sent only with the explicit flag.
      assert.doesNotMatch(sent.prompt, /secret-|synthetic-private-branch|person@example|private\.example|11111111-1111/);
      assert.ok(!sent.prompt.includes(root)); assert.notEqual(sent.cwd, process.cwd());
      assert.equal(Buffer.byteLength(sent.prompt), output.preview.promptBytes);
      assert.equal(sent.args[0], via === "claude" ? "-p" : "exec");
      assert.ok(sent.args.includes(via === "claude" ? "--no-session-persistence" : "--ephemeral"));
      assert.ok(!sent.args.some((arg) => arg.includes("content-is-not-returned")));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("review does not invoke an agent without flagged context and rejects ambiguous/unsupported input", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-empty-"));
  try {
    const fixture = await createInsightsFixture(root);
    await writeFile(fixture.config, JSON.stringify({ disabledRules: ["session-outlier", "cache-waste", "model-pricing", "compaction-heavy", "subagent-share", "long-context", "unused-skills", "unused-mcp", "idle-cache", "time-pattern"] }));
    const result = run(["review", "--session", fixture.sessionKey, "--via", "claude", "--send-content", "--json", ...fixture.flags], { ...process.env, PATH: root });
    assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).preview.excerpts, 0); assert.equal(JSON.parse(result.stdout).preview.mode, "dry-run");
    for (const args of [["--session", "/secret-key", "--via", "claude"], ["--session", fixture.sessionKey, "--via", "secret-command"], ["--session", "aaaaaaaaaaaa", "--via", "codex"]]) {
      const bad = run(["review", ...args, ...fixture.flags]); assert.equal(bad.status, 2); assert.doesNotMatch(bad.stderr, /secret-|\/Users|\.jsonl/);
    }
    assert.match(run(["review", "--help"]).stdout, /off by default/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("agent wrapper fails closed on missing authorization, errors, timeout and malformed responses", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-agent-")), previous = process.env["PATH"];
  try {
    process.env["PATH"] = `${root}:${previous}`;
    await assert.rejects(invokeReviewAgent("claude", "synthetic", false), /explicit authorization/);
    await fakeCli(root, "claude", "process.stdin.resume(); process.stderr.write('secret-cli-error /secret-path'); process.exit(1);");
    await assert.rejects(invokeReviewAgent("claude", "synthetic", true), (error: Error) => !/secret-/.test(error.message));
    await fakeCli(root, "claude", "process.stdin.resume(); setInterval(() => {}, 1000);");
    await assert.rejects(invokeReviewAgent("claude", "synthetic", true, 100), /timed out/);
    await fakeCli(root, "claude", "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('secret-unstructured-response'));");
    assert.equal((await invokeReviewAgent("claude", "synthetic", true)).assessment, "unknown");
    await fakeCli(root, "claude", "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('x'.repeat(70_000)));");
    await assert.rejects(invokeReviewAgent("claude", "synthetic", true), /too much output/);
    await fakeCli(root, "claude", "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({type:'result',structured_output:{assessment:'expected',confidence:'medium',suggestion:'none'},result:'secret-cli-prose'})));");
    assert.equal((await invokeReviewAgent("claude", "synthetic", true)).assessment, "expected");
    await fakeCli(root, "codex", "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({assessment:'unknown',confidence:'low',suggestion:'none',extra:'secret-cli-prose'})}})));");
    assert.deepEqual(await invokeReviewAgent("codex", "synthetic", true), { assessment: "unknown", confidence: "low", suggestion: "none" });
  } finally { process.env["PATH"] = previous; await rm(root, { recursive: true, force: true }); }
});

test("Codex review selects only supported prose near flags and excludes reasoning, system messages and tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-codex-context-"));
  try {
    const items = sessions(5); for (const s of items) { s.provider = "codex"; s.metrics.compactions = 3; }
    const cards = buildInsights(items, context(), "2026-10-01T00:00:00Z").items;
    const path = join(root, "synthetic.jsonl"), s = session(1, { provider: "codex" });
    const records = [
      { type: "session_meta", payload: { id: "11111111-1111-4111-8111-111111111111", cwd: "/secret path/project" } },
      { type: "response_item", payload: { type: "message", role: "system", content: [{ type: "input_text", text: "secret-system" }] } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Please examine /secret path/project and api_key=secret-token-value" }] } },
      { type: "response_item", payload: { type: "reasoning", summary: [{ text: "secret-reasoning" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", channel: "analysis", content: [{ type: "output_text", text: "secret-analysis-channel" }] } },
      { type: "response_item", payload: { type: "function_call", arguments: "secret-command" } },
      { type: "compacted", content: "secret-summary" },
      { type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage", content: [{ type: "output_text", text: "A focused context would help." }] } } },
      { type: "response_item", payload: { type: "function_call_output", output: "secret-tool-output" } },
    ];
    await writeFile(path, records.map((record) => JSON.stringify(record)).join("\n"));
    const prepared = await prepareReview(path, s, cards, "codex", 200_000, await captureReviewSource(path, "codex"));
    assert.ok(prepared.preview.excerpts >= 2); assert.match(prepared.prompt, /focused context/);
    assert.doesNotMatch(prepared.prompt, /secret-|11111111|secret path/);
    assert.ok(prepared.preview.omittedBlocks >= 3);
    assert.equal(prepared.preview.mode, "dry-run");
  } finally { await rm(root, { recursive: true, force: true }); }
});
