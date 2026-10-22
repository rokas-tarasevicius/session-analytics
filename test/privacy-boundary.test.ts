import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { analyzeMachineSessions } from "../src/analyzer.ts";
import { exportFiles } from "../src/interop/exports.ts";
import { shareSnapshot } from "../src/interop/sharing.ts";
import { serveMcp, PROTOCOL_VERSION } from "../src/mcp/server.ts";
import { toolDefinitions } from "../src/mcp/tools.ts";
import { createSessionAnalyticsFixture, plantPrivacySentinels, privacySentinelPattern } from "./fixtures.ts";

test("private metadata canaries stay out of snapshots, reports, every export and MCP tool", async () => {
  const directory = await mkdtemp(join(tmpdir(), "privacy-boundary-"));
  try {
    const fixture = await createSessionAnalyticsFixture(directory);
    await plantPrivacySentinels(fixture);
    const snapshot = await analyzeMachineSessions(fixture);
    assert.ok(snapshot.summary.analyzedSessions >= 5);
    const serialized = JSON.stringify(snapshot);
    assert.doesNotMatch(serialized, privacySentinelPattern);
    for (const format of ["csv", "ndjson", "otlp-json"] as const) {
      const files = exportFiles(snapshot, format);
      assert.ok(Object.keys(files).length > 0);
      for (const [name, content] of Object.entries(files)) assert.doesNotMatch(name + content, privacySentinelPattern, format);
    }
    const shared = shareSnapshot(snapshot, Buffer.alloc(32, 7), 2);
    assert.ok(shared.repositories.length > 0, "sharing checks a retained cohort, not an empty projection");
    assert.doesNotMatch(JSON.stringify(shared), privacySentinelPattern);

    const file = join(directory, "snapshot.json");
    await writeFile(file, serialized);
    const report = spawnSync(process.execPath, [new URL("../bin/session-analytics.ts", import.meta.url).pathname,
      "report", "--snapshot", file], { encoding: "utf8", timeout: 15_000,
      env: { ...process.env, SESSION_ANALYTICS_OFFLINE: "1", SESSION_ANALYTICS_REMOTE: "",
        SESSION_ANALYTICS_DATA_DIR: fixture.dataDir, SESSION_ANALYTICS_ADDITIONAL_PROVIDERS: "0",
        SESSION_ANALYTICS_CLAUDE_ROOT: fixture.claudeRoot, SESSION_ANALYTICS_CODEX_ROOT: fixture.codexRoot,
        SESSION_ANALYTICS_CODEX_ARCHIVE_ROOT: fixture.codexArchiveRoot, SESSION_ANALYTICS_CURSOR_DATABASE: fixture.cursorDatabasePath,
        SESSION_ANALYTICS_CONDUCTOR_DATABASE: fixture.databasePath } });
    assert.equal(report.status, 0, report.stderr);
    assert.match(report.stdout, /Session Analytics/);
    assert.doesNotMatch(report.stdout + report.stderr, privacySentinelPattern);

    const input = new PassThrough(), output = new PassThrough();
    const server = serveMcp({ analysis: {}, ttlSeconds: 60, input, output, load: async () => ({ analytics: snapshot }) });
    let buffer = "";
    try {
      await new Promise<void>((resolve, reject) => {
        const responses = new Set<number>();
        const timer = setTimeout(() => reject(new Error("MCP sentinel probe timed out.")), 5_000);
        output.on("data", (chunk: Buffer) => {
          buffer += String(chunk);
          const lines = buffer.trimEnd().split("\n");
          for (const line of lines) {
            let response;
            try { response = JSON.parse(line); } catch { continue; }
            if (responses.has(response.id)) continue;
            try {
              assert.equal(response.result?.isError, false, line);
              assert.ok(response.result?.structuredContent, line);
              assert.doesNotMatch(line, privacySentinelPattern);
              responses.add(response.id);
              if (responses.size === toolDefinitions.length) { clearTimeout(timer); resolve(); }
            } catch (error) { clearTimeout(timer); reject(error); }
          }
        });
        const repositoryId = snapshot.repositories.find((row) => row.summary.sessions > 0)!.repository.id;
        for (const [id, tool] of toolDefinitions.entries()) {
          input.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool.name,
            arguments: { ...(tool.name === "budget_status" ? {} : { window: "all" }), ...(tool.name === "repo_profile" || tool.name === "compare_agents" ? { repositoryId } : {}) },
            _meta: { "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION, "io.modelcontextprotocol/clientCapabilities": {} } } }) + "\n");
        }
      });
      assert.doesNotMatch(buffer, privacySentinelPattern);
    } finally { server.close(); await server.closed; }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
