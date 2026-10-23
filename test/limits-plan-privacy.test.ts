import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createInterface } from "node:readline";
import { once } from "node:events";

import { collectLimits } from "../src/limits/index.ts";
import { codexAccountState } from "../src/limits/codex-account.ts";
import { ledgerName, readLedger, writeLedger } from "../src/limits/ledger.ts";
import { validateLimitsSnapshot } from "../src/limits/machines.ts";
import { createSessionAnalyticsFixture } from "./fixtures.ts";

const bin = new URL("../bin/session-analytics.ts", import.meta.url).pathname;

test("Codex free-text plan sentinel is absent from whole snapshots, ledger, CLI, terminal report and MCP output", { timeout: 120000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "limits-plan-privacy-"));
  try {
    const source = await createSessionAnalyticsFixture(directory);
    const clock = Math.floor(Date.now() / 1000), sentinel = "private_sentinel_branch_and_prompt";
    const absent = (output: string) => assert.doesNotMatch(output, /private_sentinel_branch_and_prompt/);
    const file = join(source.codexRoot, "2026/07/20", readdirSync(join(source.codexRoot, "2026/07/20"))[0]!);
    writeFileSync(file, readFileSync(file, "utf8").split("\n").map((line) => {
      if (!line) return line;
      const row = JSON.parse(line);
      if (row.type === "session_meta") row.payload.creator_account_id = "synthetic-account";
      return JSON.stringify(row);
    }).join("\n"));
    appendFileSync(file, JSON.stringify({ type: "event_msg", timestamp: new Date(clock * 1000).toISOString(), payload: {
      type: "token_count", rate_limits: { plan_type: sentinel, primary: { used_percent: 42, window_minutes: 10080, resets_at: clock + 86400 } },
    } }) + "\n");
    const env = { HOME: directory, PATH: process.env["PATH"], TMPDIR: tmpdir(), CLAUDE_CONFIG_DIR: join(directory, "empty"),
      SESSION_ANALYTICS_CLAUDE_EVENT_LOGS: join(directory, "empty"), SESSION_ANALYTICS_OFFLINE: "1" };
    const options = { ...source, noIndex: false, offline: true };
    const snapshot = await collectLimits(options, env, clock);
    absent(JSON.stringify(snapshot));
    assert.equal(snapshot.observations.find((row) => row.usedPercent === 42)?.planType, "unknown");
    assert.equal(snapshot.accounts.find((account) => account.provider === "codex")?.planEvidence?.planType, "unknown");
    absent(JSON.stringify(snapshot));
    absent(readFileSync(join(source.dataDir, ledgerName), "utf8"));

    const accountResponse = codexAccountState({ rateLimits: { planType: sentinel, primary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: clock + 86400 } } }, clock)!;
    assert.equal(accountResponse.planType, "unknown");
    absent(JSON.stringify(accountResponse));
    // Persisted and remote evidence must re-enter through the same closed boundary, including pre-fix ledgers.
    const poisoned = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
    const account = poisoned.accounts.find((item) => item.provider === "codex")!;
    (account.planEvidence as unknown as Record<string, unknown>)["planType"] = sentinel;
    absent(JSON.stringify(validateLimitsSnapshot(poisoned)));
    const disk = JSON.parse(readFileSync(join(source.dataDir, ledgerName), "utf8")) as { accounts: Record<string, { planEvidence: Record<string, unknown> }> };
    disk.accounts[account.key]!.planEvidence["planType"] = sentinel;
    writeFileSync(join(source.dataDir, ledgerName), JSON.stringify(disk));
    const imported = readLedger(source.dataDir, clock).ledger!;
    absent(JSON.stringify(imported));
    writeLedger(source.dataDir, imported, clock);
    absent(readFileSync(join(source.dataDir, ledgerName), "utf8"));

    const args = ["--offline", "--no-remote", "--data-dir", source.dataDir, "--claude-root", source.claudeRoot,
      "--codex-root", source.codexRoot, "--codex-archive-root", source.codexArchiveRoot];
    const run = (command: string[], input?: string) => {
      const result = spawnSync(process.execPath, [bin, ...command], { env, encoding: "utf8", input, timeout: 120000, maxBuffer: 16 << 20 });
      assert.equal(result.status, 0, result.stderr);
      absent(result.stdout + result.stderr);
      return result.stdout;
    };
    const limits = run(["limits", "--json", ...args]);
    assert.equal(JSON.parse(limits).accounts.find((item: { provider: string }) => item.provider === "codex").planEvidence.planType, "unknown");
    const terminal = run(["limits", ...args]);
    assert.match(terminal, /reported as unknown/);
    const status = run(["limits", "statusline", ...args], JSON.stringify({ plan_type: sentinel, rate_limits: { five_hour: { used_percentage: 46, resets_at: clock + 3600 } } }));
    assert.match(status, /5h 46%/);
    const analysis = [...args, "--no-additional-providers", "--cursor-database", source.cursorDatabasePath, "--database", source.databasePath];
    assert.match(run(["report", ...analysis]), /session/i);
    mkdirSync(join(source.repositoryRoot, ".git"), { recursive: true });
    const child = spawn(process.execPath, [bin, "mcp", ...analysis.filter((arg) => arg !== "--no-remote"), "--mcp-cwd", source.repositoryRoot], { env, stdio: ["pipe", "pipe", "pipe"] });
    const lines = createInterface({ input: child.stdout });
    let output = "", stderr = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const send = (message: object) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
    try {
      const result = new Promise<Record<string, unknown>>((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", () => reject(new Error("MCP exited before replying")));
        lines.on("line", (line) => {
          const message = JSON.parse(line);
          if (message.id === 1) {
            send({ method: "notifications/initialized" });
            send({ id: 2, method: "tools/call", params: { name: "usage_summary", arguments: { window: "all" } } });
          }
          if (message.id === 2) resolve(message.result);
        });
      });
      send({ id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "privacy-fixture", version: "1" } } });
      const response = await result;
      absent(output + stderr);
      assert.equal(response["isError"], false, output);
      assert.ok(response["structuredContent"]);
    } finally {
      const ended = once(child, "exit");
      child.stdin.end();
      await ended;
      lines.close();
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
