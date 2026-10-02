import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { redactExcerpt } from "../src/insights/redact.ts";
import { invokeReviewAgent, projectAssessment } from "../src/insights/review-agent.ts";
import { prepareReview } from "../src/insights/review-context.ts";
import { buildInsights } from "../src/insights/engine.ts";
import { context, createInsightsFixture, session, sessions } from "./insights-fixtures.ts";
import type { InsightsReport, ReviewPreview } from "../src/types.ts";

const bin = resolve(import.meta.dirname, "../bin/session-analytics.ts");
const run = (args: string[], env: NodeJS.ProcessEnv = process.env) => spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", env, timeout: 30_000, maxBuffer: 2_000_000 });
async function fakeCli(directory: string, name: "claude" | "codex", body: string): Promise<void> {
  const path = join(directory, name);
  await writeFile(path, `#!${process.execPath}\n${body}\n`);
  await chmod(path, 0o755);
}

test("insights CLI returns content-free cards and applies shared source, config and date options", async () => {
  const root = await mkdtemp(join(tmpdir(), "insights-command-"));
  try {
    const fixture = await createInsightsFixture(root);
    const result = run(["insights", "--json", ...fixture.flags]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as InsightsReport;
    assert.ok(report.cards.length >= 6); assert.equal(report.coverage.length, 10);
    assert.doesNotMatch(result.stdout, /secret-|content-is-not-returned|private-branch|11111111-1111/);
    const text = run(["insights", ...fixture.flags]); assert.equal(text.status, 0, text.stderr); assert.match(text.stdout, /not an invoice/); assert.match(text.stdout, /Rule coverage/);
    const filtered = run(["insights", "--json", ...fixture.flags, "--from", "2026-09-06"]);
    assert.equal(filtered.status, 0, filtered.stderr); assert.equal((JSON.parse(filtered.stdout) as InsightsReport).coverage[0]!.totalSessions, 1);
    for (const args of [["--from", "2026-02-30"], ["--unknown", "secret-value"], ["--json", "--json"], ["--insights-config"]]) {
      const invalid = run(["insights", ...fixture.flags, ...args]); assert.equal(invalid.status, 2); assert.doesNotMatch(invalid.stderr, /secret-value|\.json|\/Users\//);
    }
    const help = run(["insights", "--help"]); assert.equal(help.status, 0); assert.match(help.stdout, /--insights-config/);
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
    const cards = buildInsights(items, context(), "2026-10-01T00:00:00Z").cards;
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
    const prepared = await prepareReview(path, s, cards, "codex", 200_000);
    assert.ok(prepared.preview.excerpts >= 2); assert.match(prepared.prompt, /focused context/);
    assert.doesNotMatch(prepared.prompt, /secret-|11111111|secret path/);
    assert.ok(prepared.preview.omittedBlocks >= 3);
    assert.equal(prepared.preview.mode, "dry-run");
  } finally { await rm(root, { recursive: true, force: true }); }
});
