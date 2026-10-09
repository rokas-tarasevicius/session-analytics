import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { appendFile, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { setTimeout as delay, setImmediate as tick } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { analyzeMachineSessions } from "../src/analyzer.ts";
import { AnalysisHeapLimitError, analysisHeapLimitMegabytes } from "../src/analysis-process.ts";
import { MAX_MESSAGE_BYTES, PROTOCOL_VERSION, serveMcp } from "../src/mcp/server.ts";
import { loadSnapshot, SNAPSHOT_DEADLINE_MS } from "../src/mcp/snapshot.ts";
import type { McpPayload, McpSnapshot } from "../src/types.ts";
import { createSessionAnalyticsFixture } from "./fixtures.ts";

const bin = fileURLToPath(new URL("../bin/session-analytics.ts", import.meta.url));
const RESPONSIVE_MS = 30_000;
const modernMeta = { "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION, "io.modelcontextprotocol/clientCapabilities": {} };
interface Response {
  id?: string | number | null;
  error?: { code: number; message: string; data?: Record<string, unknown> };
  result?: Record<string, unknown> & { isError?: boolean; content?: Array<{ type: string; text: string }>; structuredContent?: McpPayload };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "session-analytics-mcp-"));
  const source = await createSessionAnalyticsFixture(root);
  await mkdir(join(source.repositoryRoot, ".git"));
  // All sensitive strings are synthetic, including tool results, errors and quota identifiers.
  const claudeDirectory = join(source.claudeRoot, (await readdir(source.claudeRoot))[0]!);
  const claudeFile = (await readdir(claudeDirectory)).find((name) => name.endsWith(".jsonl"))!;
  await appendFile(join(claudeDirectory, claudeFile), [
    { type: "user", timestamp: "2026-07-20T12:03:00Z", message: { content: [{ type: "tool_result", tool_use_id: "tool-one", is_error: true, content: "SECRET_RESULT" }] }, toolUseResult: { stderr: "SECRET_ERROR", stdout: "SECRET_OUTPUT" } },
    { type: "assistant", timestamp: "2026-07-20T12:04:00Z", message: { id: "SECRET_MESSAGE_ID", content: [{ type: "tool_use", id: "SECRET_TOOL_ID", name: "mcp__fixture-server__lookup", input: { path: "/SECRET_PATH", token: "SECRET_CREDENTIAL" } }] } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  const codexDirectory = join(source.codexRoot, "2026/07/20");
  const codexFile = (await readdir(codexDirectory))[0]!;
  await appendFile(join(codexDirectory, codexFile), JSON.stringify({ type: "event_msg", timestamp: new Date().toISOString(), payload: {
    type: "token_count", rate_limits: { limit_id: "SECRET_LIMIT_ID", primary: { window_minutes: 300, used_percent: 42, resets_at: Math.floor(Date.now() / 1000) + 3600 } },
  } }) + "\n");
  const args = ["--no-index", "--no-additional-providers", "--offline", "--claude-root", source.claudeRoot, "--codex-root", source.codexRoot, "--codex-archive-root", source.codexArchiveRoot,
    "--cursor-database", source.cursorDatabasePath, "--database", source.databasePath, "--mcp-cwd", source.repositoryRoot];
  return { root, source, args };
}

function client(args: string[], cwd: string, settings: NodeJS.ProcessEnv = {}, entrypoint = bin) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("SESSION_ANALYTICS_") && key !== "CLAUDE_PROJECT_DIR"));
  const processChild = spawn(process.execPath, [entrypoint, "mcp", ...args], { cwd, env: { ...env, SESSION_ANALYTICS_NO_INDEX: "1", SESSION_ANALYTICS_ADDITIONAL_PROVIDERS: "0", SESSION_ANALYTICS_OFFLINE: "1", ...settings }, stdio: ["pipe", "pipe", "pipe"] });
  const responses: Response[] = [];
  const waiters = new Map<string | number | null, { resolve: (response: Response) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let stderr = "", invalid = "", nextId = 1;
  processChild.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const lines = createInterface({ input: processChild.stdout });
  lines.on("line", (line) => {
    let response: Response;
    try { response = JSON.parse(line) as Response; }
    catch { invalid += line; return; }
    responses.push(response);
    const waiter = waiters.get(response.id ?? null);
    if (waiter) { clearTimeout(waiter.timer); waiters.delete(response.id ?? null); waiter.resolve(response); }
  });
  processChild.on("exit", () => {
    for (const waiter of waiters.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("Server exited before replying.")); }
    waiters.clear();
  });
  // The stdio loop must answer within this budget even while a scan runs.
  function wait(id: string | number | null, timeoutMs = RESPONSIVE_MS): Promise<Response> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(id); reject(new Error("MCP response timeout.")); }, timeoutMs);
      waiters.set(id, { resolve, reject, timer });
    });
  }
  function send(message: object): void { processChild.stdin.write(JSON.stringify(message) + "\n"); }
  function request(method: string, params?: object, timeoutMs?: number): Promise<Response> {
    const id = nextId++;
    const result = wait(id, timeoutMs); send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }); return result;
  }
  /** Resolves once stderr matches; rejects if the process exits first. */
  function stderrMatch(pattern: RegExp): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = (): void => { if (pattern.test(stderr)) { processChild.stderr.off("data", check); processChild.off("exit", exited); resolve(); } };
      const exited = (): void => { processChild.stderr.off("data", check); reject(new Error("Process exited before it was ready.")); };
      processChild.stderr.on("data", check); processChild.once("exit", exited); check();
    });
  }
  /**
   * A cold scan is CPU-bound and slows with machine load, so it is bounded by the
   * server's own snapshot deadline, not the responsiveness budget. Liveness is
   * still checked: the server must keep answering pings while the scan runs.
   */
  async function scanRequest(method: string, params: object): Promise<Response> {
    let settled = false;
    const result = request(method, params, SNAPSHOT_DEADLINE_MS + RESPONSIVE_MS).finally(() => { settled = true; });
    while (!settled) {
      await Promise.race([result.catch(() => {}), delay(1000)]);
      if (!settled) assert.deepEqual((await request("ping")).result, {}, "stdio stays responsive during the scan");
    }
    return await result;
  }
  return { processChild, responses, request, scanRequest, send, wait, stderrMatch, stderr: () => stderr, invalid: () => invalid,
    async initialize(protocolVersion = "2025-11-25") {
      const response = await request("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "fixture-client", version: "1" } });
      send({ jsonrpc: "2.0", method: "notifications/initialized" }); return response;
    },
    async close() {
      if (processChild.exitCode !== null || processChild.signalCode) return;
      const ended = once(processChild, "exit");
      const kill = setTimeout(() => processChild.kill("SIGKILL"), 2000);
      processChild.stdin.end(); await ended; clearTimeout(kill); lines.close();
    },
  };
}

test("spawned MCP server negotiates both eras and calls every tool without content leakage", async () => {
  const f = await fixture(); const c = client(f.args, f.source.repositoryRoot);
  try {
    assert.equal((await c.initialize()).result?.["protocolVersion"], "2025-11-25");
    assert.deepEqual((await c.request("ping")).result, {});
    const list = await c.request("tools/list");
    const tools = list.result?.["tools"] as Array<{ name: string; inputSchema: { additionalProperties: boolean }; annotations: { readOnlyHint: boolean } }>;
    assert.equal(tools.length, 6);
    assert.ok(!tools.some((tool) => tool.name === "unused_extensions"));
    assert.ok(tools.every((tool) => tool.inputSchema.additionalProperties === false && tool.annotations.readOnlyHint));
    const calls = await Promise.all(tools.map((tool) => c.request("tools/call", { name: tool.name, arguments: tool.name === "budget_status" ? {} : { window: "all" } })));
    for (const response of calls) {
      assert.equal(response.error, undefined); assert.equal(response.result?.isError, false);
      const payload = response.result!.structuredContent!;
      assert.equal(payload.schemaVersion, 1); assert.equal(payload.scope.kind, "repository");
      assert.match(payload.scope.repositoryId!, /^conductor-[0-9a-f]{20}$/);
      assert.deepEqual(JSON.parse(response.result!.content![1]!.text), payload);
      assert.match(response.result!.content![0]!.text, /not an invoice/);
    }
    const stats = calls[tools.findIndex((tool) => tool.name === "tool_stats")]!.result!.structuredContent!;
    assert.ok("tools" in stats.data);
    assert.ok((stats.data.tools.find((tool) => tool.name === "Bash")?.calls ?? 0) > 0);
    assert.ok(stats.data.tools.every((tool) => Object.keys(tool).sort().join() === "calls,name"));
    const budget = calls[tools.findIndex((tool) => tool.name === "budget_status")]!.result!.structuredContent!;
    assert.deepEqual(Object.keys(budget.data).sort(), ["today", "week"]);
    const discover = await c.request("server/discover", { _meta: modernMeta });
    assert.equal(discover.result?.["resultType"], "complete");
    assert.ok((discover.result?.["supportedVersions"] as string[]).includes(PROTOCOL_VERSION));
    const modern = await c.request("tools/call", { _meta: modernMeta, name: "usage_summary", arguments: { window: "all", groupBy: "model" } });
    assert.equal(modern.result?.["resultType"], "complete");
    assert.equal(modern.result?.isError, false);
    for (const tool of tools) {
      const response = await c.request("tools/call", { _meta: modernMeta, name: tool.name, arguments: tool.name === "budget_status" ? {} : { window: "all" } });
      assert.equal(response.result?.["resultType"], "complete"); assert.equal(response.result?.isError, false);
    }
    assert.equal(c.invalid(), "");
    const output = JSON.stringify(c.responses) + c.stderr();
    assert.doesNotMatch(output, /SECRET_|content-is-not-returned|secret-command|secret-skill-args|\/fixtures\/|fixture-skills|11111111-1111|22222222-2222|conductor-codex|codex-fixture|human request/);
    assert.ok(!output.includes(f.root)); assert.ok(!output.includes(f.source.remote));
    assert.equal(c.stderr(), "");
  } finally { await c.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("modern clients can call directly; missing capabilities and version mismatches are rejected", async () => {
  const f = await fixture(); const c = client(f.args, f.source.repositoryRoot);
  try {
    assert.equal((await c.request("tools/list")).error?.code, -32600);
    const version = await c.request("server/discover", { _meta: { ...modernMeta, "io.modelcontextprotocol/protocolVersion": "2099-01-01" } });
    assert.equal(version.error?.code, -32022);
    assert.deepEqual(version.error?.data?.["supported"], [PROTOCOL_VERSION, "2025-11-25", "2025-06-18"]);
    assert.equal((await c.request("tools/list", { _meta: { "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION } })).error?.code, -32602);
    assert.equal((await c.request("tools/call", { _meta: modernMeta, name: "recent_sessions", arguments: { window: "all", limit: 1 } })).result?.isError, false);
    assert.equal((await c.request("tools/list", { _meta: modernMeta })).result?.["resultType"], "complete");
    assert.equal((await c.request("roots/list", { _meta: modernMeta })).error?.code, -32601);
  } finally { await c.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("strict wire/input validation, fragmented frames, bounded input and safe errors", async () => {
  const f = await fixture(); const c = client(f.args, f.source.repositoryRoot);
  try {
    assert.equal((await c.initialize("2099-01-01")).result?.["protocolVersion"], "2025-11-25");
    assert.equal((await c.request("initialize", {})).error?.code, -32600);
    assert.equal((await c.request("tools/call", { name: "SECRET_UNKNOWN_TOOL" })).error?.code, -32602);
    for (const args of [{ path: "/SECRET_PATH" }, { window: "SECRET_WINDOW" }, { limit: 0 }, { limit: 51 }, { limit: 1.1 }, { offset: -1 }, { repositoryId: "/SECRET_PATH" }, { scope: "machine", repositoryId: "discovered-00000000000000000000" }, null, [], { "__proto__": "bad" }]) {
      // JSON.parse preserves an own __proto__ key for the last adversarial case below.
      if (args && Object.keys(args).length === 0) continue;
      const result = await c.request("tools/call", { name: "recent_sessions", arguments: args });
      assert.equal(result.result?.isError, true);
    }
    const pollution = await c.request("tools/call", { name: "usage_summary", arguments: JSON.parse('{"__proto__":{"polluted":true}}') });
    assert.equal(pollution.result?.isError, true);
    assert.equal((await c.request("tools/call", { name: "compare_agents", arguments: { scope: "machine" } })).result?.isError, true);
    assert.equal((await c.request("tools/list", { cursor: "SECRET_CURSOR" })).error?.code, -32602);
    assert.equal((await c.request("tools/call", { name: "usage_summary", arguments: { repositoryId: "discovered-00000000000000000000" } })).result?.isError, true);
    for (const line of ["{SECRET_BAD_JSON}", "[]", "null", '{"jsonrpc":"2.0","id":null,"method":"ping"}']) {
      const response = c.wait(null); c.processChild.stdin.write(line + "\n");
      assert.ok([-32700, -32600].includes((await response).error!.code));
    }
    const fragmented = c.wait("fragment");
    c.processChild.stdin.write('{"jsonrpc":"2.0","id":"frag');
    c.processChild.stdin.write('ment","method":"ping"}\r\n');
    assert.deepEqual((await fragmented).result, {});
    const oversized = c.wait(null);
    c.processChild.stdin.write("x".repeat(MAX_MESSAGE_BYTES + 1) + "\n");
    assert.equal((await oversized).error?.code, -32600);
    assert.deepEqual((await c.request("ping")).result, {});
    const before = c.responses.length;
    c.send({ jsonrpc: "2.0", method: "tools/call", params: { name: "usage_summary" } });
    c.send({ jsonrpc: "2.0", method: "notifications/unknown" });
    await c.request("ping");
    assert.equal(c.responses.length, before + 1);
    assert.doesNotMatch(JSON.stringify(c.responses), /SECRET_|polluted/);
  } finally { await c.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("default repository isolation, empty repository, explicit launch ceiling and no-repository fallback", async () => {
  const f = await fixture();
  const empty = join(f.root, "empty-repo"); await mkdir(join(empty, ".git"), { recursive: true });
  for (const [context, expectedScope, expectedSessions, extra] of [
    [empty, "repository", 0, []],
    [f.root, "machine", 5, []],
    [f.source.repositoryRoot, "repository", 0, ["--repo-name", "quiet-repository"]],
  ] as const) {
    const args = f.args.slice(0, -2).concat(["--mcp-cwd", context, ...extra]);
    const c = client(args, f.source.repositoryRoot);
    try {
      await c.initialize("2025-06-18");
      const payload = (await c.request("tools/call", { name: "usage_summary", arguments: { window: "all" } })).result!.structuredContent!;
      assert.equal(payload.scope.kind, expectedScope); assert.equal(payload.totals.sessions, expectedSessions);
      if (extra.length) {
        const machine = (await c.request("tools/call", { name: "usage_summary", arguments: { scope: "machine", window: "all" } })).result!.structuredContent!;
        assert.equal(machine.totals.sessions, 0);
      }
      if (expectedScope === "machine") assert.equal((await c.request("tools/call", { name: "repo_profile" })).result?.isError, true);
    } finally { await c.close(); }
  }
  await rm(f.root, { recursive: true, force: true });
});

test("stdio stays responsive during a coalesced scan, bounds concurrency and suppresses cancelled responses", async () => {
  const f = await fixture();
  try {
    const analytics = await analyzeMachineSessions({ ...f.source, mcpCwd: f.source.repositoryRoot });
    const snapshot: McpSnapshot = { analytics };
    const input = new PassThrough(), output = new PassThrough();
    const responses: Response[] = [];
    createInterface({ input: output }).on("line", (line) => responses.push(JSON.parse(line) as Response));
    let finish!: (value: McpSnapshot) => void, loads = 0, aborted = false;
    const server = serveMcp({ analysis: {}, ttlSeconds: 60, input, output, load: async (signal) => {
      loads += 1; signal.addEventListener("abort", () => { aborted = true; });
      return await new Promise<McpSnapshot>((resolve) => { finish = resolve; });
    } });
    const send = (id: number, method: string, params: object = {}) => input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: modernMeta } }) + "\n");
    for (let id = 1; id <= 17; id += 1) send(id, "tools/call", { name: "usage_summary", arguments: { window: "all" } });
    input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1, reason: "SECRET_REASON" } }) + "\n");
    send(20, "ping"); send(2, "tools/call", { name: "usage_summary" });
    await tick();
    assert.equal(loads, 1); assert.ok(responses.some((r) => r.id === 20 && r.result));
    assert.equal(responses.find((r) => r.id === 17)?.error?.code, -32000);
    assert.equal(responses.find((r) => r.id === null)?.error?.code, -32600);
    finish(snapshot); await tick();
    assert.ok(!responses.some((r) => r.id === 1));
    assert.equal(responses.filter((r) => r.result?.structuredContent).length, 15);
    send(21, "tools/call", { name: "usage_summary", arguments: { window: "all" } }); await tick();
    assert.equal(loads, 1);
    input.end(); await server.closed; assert.equal(aborted, true);
    output.destroy();
  } finally { await rm(f.root, { force: true, recursive: true }); }
});

test("MCP startup options and snapshot failures do not expose paths or exceptions", async () => {
  for (const args of [["--bad-SECRET_OPTION"], ["--mcp-ttl", "0"], ["--mcp-ttl", "Infinity"], ["--mcp-cwd"]]) {
    const result = spawnSync(process.execPath, [bin, "mcp", ...args], { encoding: "utf8" });
    assert.equal(result.status, 2); assert.equal(result.stdout, ""); assert.doesNotMatch(result.stderr, /SECRET_| at /);
  }
  const help = spawnSync(process.execPath, [bin, "mcp", "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0); assert.match(help.stdout, /stdio/);
  const f = await fixture();
  const c = client([...f.args, "--rate-card", join(f.root, "SECRET_MISSING_RATE_CARD")], f.source.repositoryRoot);
  try {
    await c.initialize();
    const result = await c.request("tools/call", { name: "budget_status" });
    assert.equal(result.result?.isError, true);
    assert.doesNotMatch(JSON.stringify(c.responses) + c.stderr(), /SECRET_|ENOENT|Error:| at /);
    assert.equal(c.stderr(), "");
  } finally { await c.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("launch context handles linked worktrees and environment/flag precedence", async () => {
  const f = await fixture();
  const worktree = join(f.root, "linked-worktree");
  await mkdir(worktree); await mkdir(join(f.source.repositoryRoot, ".git/worktrees/linked"), { recursive: true });
  await writeFile(join(worktree, ".git"), `gitdir: ${join(f.source.repositoryRoot, ".git/worktrees/linked")}\n`);
  const c = client([...f.args.slice(0, -2), "--mcp-ttl", "5"], f.root, {
    CLAUDE_PROJECT_DIR: worktree, SESSION_ANALYTICS_MCP_TTL: "invalid-SECRET_TTL",
  });
  try {
    await c.initialize();
    const result = await c.request("tools/call", { name: "usage_summary", arguments: { window: "all" } });
    assert.equal(result.result?.isError, false);
    assert.equal(result.result!.structuredContent!.scope.kind, "repository");
    assert.equal(result.result!.structuredContent!.totals.sessions, 5);
    assert.equal(result.result!.structuredContent!.snapshot.ttlSeconds, 5);
  } finally { await c.close(); await rm(f.root, { force: true, recursive: true }); }
});

test("spawned stdio server shuts down promptly on signals and EOF, including partial frames", async () => {
  const f = await fixture();
  try {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      const c = client(f.args, f.root);
      try {
        await c.initialize();
        const exited = once(c.processChild, "exit");
        const fallback = setTimeout(() => c.processChild.kill("SIGKILL"), 2000);
        c.processChild.kill(signal);
        const [code, cause] = await exited; clearTimeout(fallback);
        assert.equal(code, 0); assert.equal(cause, null); assert.equal(c.stderr(), "");
      } finally { await c.close(); }
    }
    const c = client(f.args, f.root);
    try {
      await c.initialize(); c.processChild.stdin.write('{"jsonrpc":"2.0","SECRET_PARTIAL":');
      await c.close(); assert.equal(c.processChild.exitCode, 0);
      assert.doesNotMatch(JSON.stringify(c.responses) + c.stderr(), /SECRET_/);
    } finally { await c.close(); }
  } finally { await rm(f.root, { force: true, recursive: true }); }
});

test("additive evidence remains content-free in report JSON and is not MCP-only filtering", async () => {
  const f = await fixture();
  try {
    const result = spawnSync(process.execPath, [bin, "report", "--json", ...f.args.slice(0, -2)], { encoding: "utf8" });
    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout) as { sessions: Array<{ mcpEvidence?: Record<string, unknown> }> };
    assert.ok(parsed.sessions.some((session) => session.mcpEvidence?.["pricingByDay"]));
    for (const session of parsed.sessions) for (const key of Object.keys(session.mcpEvidence ?? {})) assert.ok(["activityState", "pricingByDay", "undatedTokens"].includes(key), key);
    assert.doesNotMatch(result.stdout, /SECRET_|secret-command|secret-skill-args|content-is-not-returned/);
    assert.ok(!result.stdout.includes(f.root));
  } finally { await rm(f.root, { force: true, recursive: true }); }
});

test("MCP demo serves only synthetic repositories and tool counts", { timeout: SNAPSHOT_DEADLINE_MS + 4 * RESPONSIVE_MS }, async () => {
  const demo = fileURLToPath(new URL("../scripts/demo.ts", import.meta.url));
  const c = client([], process.cwd(), {}, demo);
  try {
    // The demo generates its synthetic history before it starts the server; the
    // server can only be held to the responsiveness budget once it exists.
    await c.stderrMatch(/Generated \d+ synthetic top-level sessions/);
    await c.initialize();
    const call = async (name: string, args: object = {}) => {
      const result = await c.request("tools/call", { name, arguments: args });
      assert.equal(result.result?.isError, false); return result.result!.structuredContent!;
    };
    // The first call runs the cold demo scan; later calls are served from the cache.
    const first = await c.scanRequest("tools/call", { name: "usage_summary", arguments: { scope: "machine", groupBy: "repository", window: "all" } });
    assert.equal(first.result?.isError, false);
    const summary = first.result!.structuredContent!;
    assert.ok("groups" in summary.data); assert.equal(summary.data.totalGroups, 6);
    const budget = await call("budget_status");
    assert.equal(budget.scope.kind, "repository"); assert.ok("today" in budget.data);
    const stats = await call("tool_stats", { window: "all", limit: 50 });
    assert.ok("tools" in stats.data);
    assert.ok(stats.data.tools.some((row) => row.calls > 20));
    assert.doesNotMatch(JSON.stringify(c.responses), /synthetic demo request|synthetic demo prompt|synthetic-never-executed|\.jsonl|\/repos\//i);
    assert.equal(c.invalid(), "");
  } finally { await c.close(); }
});

test("missing and unreadable provider sources stay visible in empty filtered MCP results", async () => {
  const f = await fixture();
  const missing = join(f.root, "SECRET_MISSING_SOURCE"), unreadable = join(f.root, "SECRET_UNREADABLE_SOURCE");
  await writeFile(unreadable, "SECRET_NOT_A_DIRECTORY");
  try {
    for (const path of [missing, unreadable]) {
      const args = [...f.args]; args[args.indexOf("--claude-root") + 1] = path;
      const c = client(args, f.root);
      try {
        await c.initialize();
        for (const name of ["usage_summary", "budget_status", "compare_agents"]) {
          const result = await c.request("tools/call", { name, arguments: { ...(name !== "compare_agents" ? { provider: "claude" } : {}), ...(name !== "budget_status" ? { window: "all" } : {}) } });
          assert.equal(result.result?.isError, false);
          const payload = result.result!.structuredContent!;
          assert.ok(payload.notes.some((note) => /sources.*incomplete/i.test(note)));
          assert.deepEqual(payload.sourceHealth.find((source) => source.provider === "claude"), {
            provider: "claude", status: "unavailable", sourcesRead: 0,
            missingSources: path === missing ? 1 : 0, unreadableSources: path === unreadable ? 1 : 0,
          });
          if (name !== "compare_agents") assert.equal(payload.totals.sessions, 0);
        }
        assert.doesNotMatch(JSON.stringify(c.responses) + c.stderr(), /SECRET_|ENOENT|ENOTDIR/);
      } finally { await c.close(); }
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("spawned MCP exits after EOF with unread stdout, without a caller-side kill", { timeout: 8000 }, async () => {
  const child = spawn(process.execPath, [bin, "mcp"], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const ended = once(child, "exit");
  // Bound the failing regression too, but record any watchdog kill as failure.
  let killed = false;
  const watchdog = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, 3000);
  try {
    for (let id = 0; id < 200; id++) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: { _meta: modernMeta } }) + "\n");
    child.stdin.end();
    const [code, signal] = await ended;
    assert.equal(killed, false, "EOF must bound stdout draining without help from the caller");
    assert.equal(code, 0); assert.equal(signal, null); assert.equal(stderr, "");
  } finally { clearTimeout(watchdog); child.stdout.destroy(); child.stderr.destroy(); if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL"); }
});

test("output overflow settles shutdown after destroying a blocked writer", async () => {
  const input = new PassThrough(), output = new PassThrough({ highWaterMark: 1 });
  const server = serveMcp({ analysis: {}, ttlSeconds: 60, input, output });
  try {
    for (let id = 0; id < 1000 && !input.destroyed; id++) input.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: { _meta: modernMeta } }) + "\n");
    await server.closed;
    assert.equal(output.destroyed, true);
    assert.equal(input.destroyed, true);
  } finally { server.close(); output.destroy(); }
});

test("spawned MCP output overflow exits while stdin remains open and stdout unread", { timeout: 8000 }, async () => {
  const child = spawn(process.execPath, [bin, "mcp"], { stdio: ["pipe", "pipe", "pipe"] });
  // The server can close stdin while the writer is still feeding the burst.
  child.stdin.on("error", () => {}); child.stderr.resume();
  const ended = once(child, "exit");
  let killed = false;
  const watchdog = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, 3000);
  try {
    for (let id = 0; id < 1000; id++) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: { _meta: modernMeta } }) + "\n");
    const [code, signal] = await ended;
    assert.equal(killed, false); assert.equal(code, 0); assert.equal(signal, null);
  } finally { clearTimeout(watchdog); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL"); }
});

test("an MCP worker heap exhaustion returns the named heap-limit error without raw child output", { timeout: 60_000 }, async () => {
  const worker = { script: new URL("./mcp-heap-worker.ts", import.meta.url), heapLimitMegabytes: 32 };
  const failure = await loadSnapshot({}, new AbortController().signal, worker).then(() => null, (error: unknown) => error);
  assert.ok(failure instanceof AnalysisHeapLimitError);
  assert.equal(failure.message, `Session analysis exceeded its ${analysisHeapLimitMegabytes} MB worker heap limit.`);
  assert.doesNotMatch(String(failure), /SECRET_|heap out of memory/i);
  // The client sees the same named message, never the child's stderr.
  const input = new PassThrough(), output = new PassThrough();
  const responses: Response[] = [];
  createInterface({ input: output }).on("line", (line) => responses.push(JSON.parse(line) as Response));
  const server = serveMcp({ analysis: {}, ttlSeconds: 60, input, output, load: (signal) => loadSnapshot({}, signal, worker) });
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "usage_summary", arguments: { window: "all" }, _meta: modernMeta } }) + "\n");
  while (!responses.length) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(responses[0]!.result?.isError, true);
  assert.equal(responses[0]!.result?.content?.[0]?.text, failure.message);
  assert.doesNotMatch(JSON.stringify(responses), /SECRET_|heap out of memory|Error:| at /i);
  input.end(); await server.closed; output.destroy();
});
