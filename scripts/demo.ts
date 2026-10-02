#!/usr/bin/env node
/**
 * Generate a synthetic, seeded set of coding-agent sessions (the 60 days up to
 * now) in a temporary directory and run session-analytics against that data only.
 *
 *   node scripts/demo.ts                   dashboard on http://127.0.0.1:4175
 *   node scripts/demo.ts --no-open         dashboard without opening a browser
 *   node scripts/demo.ts --port 4180       choose another loopback port
 *   node scripts/demo.ts report [--json]   terminal report or JSON snapshot
 *   node scripts/demo.ts --keep            keep the generated data after exit
 *
 * Every provider source is passed explicitly, and the child process runs with
 * HOME pointed at an empty directory inside the demo root, so neither the
 * explicit flags nor profile discovery can reach the machine's real history.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(projectRoot, "bin", "session-analytics.ts");
const DAY = 86_400_000;
const DAYS = 60;

// ---------------------------------------------------------------------------
// Arguments

const argv = process.argv.slice(2);
const reportMode = argv[0] === "report";
const options = reportMode ? argv.slice(1) : argv;
const has = (flag: string): boolean => options.includes(flag);
function valueOf(flag: string): string | undefined {
  const index = options.indexOf(flag);
  return index >= 0 ? options[index + 1] : undefined;
}
const known = new Set(["--json", "--keep", "--no-open", "--port", "--help"]);
for (let index = 0; index < options.length; index += 1) {
  const flag = options[index] ?? "";
  if (!known.has(flag)) fail(`Unknown demo argument: ${flag}`);
  if (flag === "--port") index += 1;
}
if (has("--json") && !reportMode) fail("--json is only valid with the report command.");
if (has("--help")) {
  process.stdout.write(
    "Usage: node scripts/demo.ts [report [--json]] [--no-open] [--port PORT] [--keep]\n" +
      "Generates synthetic sessions in a temporary directory and analyzes only that data.\n",
  );
  process.exit(0);
}
const port = Number(valueOf("--port") ?? "4175");
if (!Number.isInteger(port) || port < 1024 || port > 65_535) fail("--port must be an integer from 1024 through 65535.");

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Seeded randomness (mulberry32); dates are anchored to the current day

let seed = 0x5e55_1011;
function random(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
  return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
}
const between = (low: number, high: number): number => low + random() * (high - low);
const integer = (low: number, high: number): number => Math.floor(between(low, high + 1));
const chance = (probability: number): boolean => random() < probability;
function pick<T>(items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error("Cannot pick from an empty list.");
  return item;
}
function weighted<T>(entries: ReadonlyArray<readonly [T, number]>): T {
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let cursor = random() * total;
  for (const [value, weight] of entries) {
    cursor -= weight;
    if (cursor <= 0) return value;
  }
  const last = entries.at(-1);
  if (!last) throw new Error("Cannot pick from an empty list.");
  return last[0];
}
/** Heavy-tailed positive integer, roughly log-normal around `median`. */
function heavy(median: number, spread: number, maximum: number): number {
  const normal = Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  return Math.max(1, Math.min(maximum, Math.round(median * Math.exp(normal * spread))));
}
function hex(length: number): string {
  let value = "";
  while (value.length < length) value += Math.floor(random() * 16).toString(16);
  return value;
}
const uuid = (): string => `${hex(8)}-${hex(4)}-4${hex(3)}-${pick(["8", "9", "a", "b"])}${hex(3)}-${hex(12)}`;
const iso = (milliseconds: number): string => new Date(milliseconds).toISOString();

// ---------------------------------------------------------------------------
// Synthetic world

interface Repository {
  name: string;
  root: string;
  weight: number;
  directories: string[];
  files: string[];
}

const repositorySpecs = [
  { name: "acme-web", weight: 28, directories: ["", "packages/ui", "apps/storefront"], files: ["src/app.tsx", "packages/ui/button.tsx", "apps/storefront/checkout.tsx"] },
  { name: "billing-api", weight: 20, directories: ["", "services/invoices"], files: ["src/handlers/invoice.go", "services/invoices/ledger.go"] },
  { name: "data-pipeline", weight: 17, directories: ["", "jobs"], files: ["jobs/daily_rollup.py", "pipeline/transform.py"] },
  { name: "mobile-app", weight: 14, directories: ["", "ios"], files: ["src/screens/Home.tsx", "ios/AppDelegate.swift"] },
  { name: "infra", weight: 12, directories: ["", "terraform"], files: ["terraform/main.tf", "k8s/deploy.yaml"] },
  { name: "docs-site", weight: 9, directories: [""], files: ["docs/getting-started.md", "astro.config.mjs"] },
] as const;

const claudeModels = [
  ["claude-opus-5", 55],
  ["claude-sonnet-5", 33],
  ["claude-fable-5-1", 6],
  ["claude-opus-4-8", 6],
] as const;
const claudeSubagentModels = [
  ["claude-haiku-4-5-20251001", 50],
  ["claude-sonnet-5", 40],
  ["claude-opus-5", 10],
] as const;
const codexModels = [
  ["gpt-5.6-sol", 42],
  ["gpt-5.5", 24],
  ["gpt-5.6-terra", 20],
  ["gpt-5.4-mini", 9],
  ["gpt-5.3-codex-spark", 5],
] as const;
const claudeTools = [
  ["Read", 32], ["Bash", 21], ["Edit", 17], ["Grep", 10], ["Glob", 6], ["Write", 4],
  ["TodoWrite", 4], ["WebFetch", 1.5], ["mcp__github__get_pull_request", 1.5], ["MultiEdit", 2],
] as const;
const skills = [
  ["code-review", 30], ["frontend-design", 18], ["webapp-testing", 14], ["release-notes", 10],
  ["session-analytics", 8], ["pdf", 5],
] as const;
const codexSkills = ["code-review", "frontend-design", "webapp-testing", "release-notes"] as const;
const effortLevels = [["low", 15], ["medium", 50], ["high", 35]] as const;

function rateCardModels(): Set<string> {
  const card = JSON.parse(readFileSync(join(projectRoot, "data", "rate-cards.json"), "utf8")) as {
    models?: Record<string, unknown>;
  };
  return new Set(Object.keys(card.models ?? {}));
}

// ---------------------------------------------------------------------------
// Writers

function writeJsonl(path: string, records: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

/** Claude Code stores a project's sessions under its cwd with `/` and `.` replaced by `-`. */
const claudeProjectDirectory = (cwd: string): string => cwd.replace(/[/.]/g, "-");

/** A working directory inside the repository or one of its linked worktrees. */
function workingDirectory(repository: Repository): string {
  const directory = pick(repository.directories);
  return directory.startsWith("/") ? directory : join(repository.root, directory);
}

/** Local-time session start, weighted toward weekday working hours. */
function sessionStart(dayStart: number): number {
  const hour = weighted([
    [8, 3], [9, 7], [10, 10], [11, 10], [12, 5], [13, 6], [14, 10], [15, 10], [16, 9],
    [17, 6], [18, 3], [19, 2], [20, 2], [21, 2], [22, 1], [23, 0.5],
  ] as const);
  return dayStart + hour * 3_600_000 + integer(0, 59) * 60_000 + integer(0, 59) * 1000;
}

interface ClaudeTurnState {
  context: number;
  clock: number;
  compactions: number;
}

function claudeUsage(model: string, state: ClaudeTurnState, output: number, longCache: boolean) {
  const created = integer(400, 4_500);
  const thinking = model.includes("haiku") ? 0 : Math.round(output * between(0.15, 0.55));
  const usage = {
    input_tokens: integer(2, 40),
    cache_creation_input_tokens: created,
    cache_read_input_tokens: state.context,
    cache_creation: longCache
      ? { ephemeral_1h_input_tokens: created, ephemeral_5m_input_tokens: 0 }
      : { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: created },
    output_tokens: output,
    output_tokens_details: { thinking_tokens: thinking },
  };
  state.context += created;
  return usage;
}

function toolInput(name: string, repository: Repository): Record<string, unknown> {
  const file = join(repository.root, pick(repository.files));
  if (name === "Read" || name === "Write") return { file_path: file };
  if (name === "Edit" || name === "MultiEdit") return { file_path: file, old_string: "[synthetic]", new_string: "[synthetic]" };
  if (name === "Bash") return { command: pick(["npm test", "git status", "go test ./...", "pytest -q", "terraform plan"]) };
  if (name === "Grep") return { pattern: "TODO", path: repository.root };
  if (name === "Glob") return { pattern: "**/*.ts" };
  return { note: "[synthetic demo input]" };
}

interface ClaudeTranscriptOptions {
  entrypoint: "cli" | "sdk-ts" | "local-agent";
  attributionAgent?: "general-purpose" | "Explore" | "Plan";
  agentId?: string;
  cwd: string;
  messages: number;
  model: string;
  repository: Repository;
  sessionId: string;
  start: number;
  subagent: boolean;
}

/** One Claude Code transcript: human turns, streamed assistant records, tool results. */
function claudeTranscript(options: ClaudeTranscriptOptions): { records: unknown[]; end: number; spawned: number } {
  const { cwd, model, repository, sessionId } = options;
  const records: unknown[] = [];
  const state: ClaudeTurnState = { clock: options.start, compactions: 0, context: options.subagent ? integer(9_000, 16_000) : integer(18_000, 32_000) };
  const effort = model.includes("haiku") ? undefined : weighted(effortLevels);
  const longCache = !options.subagent && chance(0.35);
  const base = { entrypoint: options.entrypoint, ...(options.attributionAgent ? { attributionAgent: options.attributionAgent } : {}), cwd, sessionId, version: "2.4.0", gitBranch: "main", ...(options.agentId ? { agentId: options.agentId, isSidechain: true } : {}) };
  let parent: string | null = null;
  let spawned = 0;
  const push = (record: Record<string, unknown>): void => {
    const uuidValue = uuid();
    records.push({ ...base, ...record, parentUuid: parent, uuid: uuidValue, timestamp: iso(state.clock) });
    parent = uuidValue;
  };
  const human = (): void => {
    push({ type: "user", message: { role: "user", content: "[synthetic demo prompt]" } });
    state.clock += integer(4, 25) * 1000;
  };

  human();
  for (let index = 0; index < options.messages; index += 1) {
    if (!options.subagent && index > 0 && chance(0.12)) {
      state.clock += integer(1, 9) * 60_000;
      human();
    }
    const messageId = `msg_${hex(24)}`;
    const requestId = `req_${hex(24)}`;
    const output = heavy(options.subagent ? 260 : 420, 0.8, 6_000);
    const tools: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
    const toolCount = weighted([[0, 18], [1, 62], [2, 15], [3, 5]] as const);
    for (let tool = 0; tool < toolCount; tool += 1) {
      let name: string = weighted(claudeTools);
      let input = toolInput(name, repository);
      if (!options.subagent && chance(0.035)) {
        name = "Task";
        input = { description: "[synthetic]", subagent_type: pick(["Explore", "general-purpose", "Plan"]) };
        spawned += 1;
      } else if (!options.subagent && chance(0.02)) {
        name = "Skill";
        input = { skill: weighted(skills), args: "[synthetic]" };
      }
      tools.push({ id: `toolu_${hex(24)}`, name, input });
    }
    const usage = claudeUsage(model, state, output, longCache);
    const content = [
      { type: "text", text: "[synthetic demo response]" },
      ...tools.map(({ id, name, input }) => ({ type: "tool_use", id, name, input })),
    ];
    const message = (blocks: unknown[], outputTokens: number) => ({
      id: messageId,
      model,
      role: "assistant",
      type: "message",
      content: blocks,
      usage: { ...usage, output_tokens: outputTokens, output_tokens_details: { thinking_tokens: Math.min(outputTokens, usage.output_tokens_details.thinking_tokens) } },
    });
    // Claude Code streams one record per content block; usage grows to its final value.
    if (tools.length > 0 && chance(0.6)) {
      push({ type: "assistant", requestId, ...(effort ? { effort } : {}), message: message(content.slice(0, 1), Math.max(1, Math.round(output * 0.2))) });
      state.clock += integer(1, 6) * 1000;
    }
    push({ type: "assistant", requestId, ...(effort ? { effort } : {}), message: message(content, output) });
    state.clock += integer(3, 40) * 1000;
    for (const tool of tools) {
      push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: tool.id, content: "[synthetic tool result]" }] } });
      state.clock += integer(1, 30) * 1000;
    }
    state.context += integer(600, 3_200);
    if (state.context > 165_000) {
      push({ type: "system", subtype: "compact_boundary", content: "Conversation compacted" });
      state.context = integer(24_000, 38_000);
      state.compactions += 1;
    }
  }
  return { records, end: state.clock, spawned };
}

function writeClaudeSession(root: string, repository: Repository, start: number): void {
  const cwd = workingDirectory(repository);
  const sessionId = uuid();
  const model = weighted(claudeModels);
  const messages = heavy(34, 0.85, 420);
  const projectDirectory = join(root, claudeProjectDirectory(cwd));
  const entrypoint = weighted([["cli", 40], ["sdk-ts", 50], ["local-agent", 10]] as const);
  const main = claudeTranscript({ entrypoint, cwd, messages, model, repository, sessionId, start, subagent: false });
  writeJsonl(join(projectDirectory, `${sessionId}.jsonl`), main.records);
  const subagents = main.spawned + (chance(0.18) ? 1 : 0);
  for (let index = 0; index < subagents; index += 1) {
    const agentId = hex(8);
    const offset = between(0.1, 0.8) * Math.max(60_000, main.end - start);
    const transcript = claudeTranscript({
      entrypoint,
      attributionAgent: pick(["general-purpose", "Explore", "Plan"] as const),
      agentId,
      cwd,
      messages: heavy(14, 0.6, 90),
      model: weighted(claudeSubagentModels),
      repository,
      sessionId,
      start: start + offset,
      subagent: true,
    });
    writeJsonl(join(projectDirectory, sessionId, "subagents", `agent-${agentId}.jsonl`), transcript.records);
  }
}

interface CodexCounter {
  cached_input_tokens: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}

function writeCodexSession(
  activeRoot: string,
  archiveRoot: string,
  repository: Repository,
  start: number,
  now: number,
  parentThreadId: string | null = null,
): string {
  const id = uuid();
  const cwd = workingDirectory(repository);
  const model = parentThreadId ? pick(["gpt-5.4-mini", "gpt-5.6-terra"] as const) : weighted(codexModels);
  const effort = weighted(effortLevels);
  const records: unknown[] = [];
  let clock = start;
  const push = (type: string, payload: Record<string, unknown>): void => {
    records.push({ timestamp: iso(clock), type, payload });
  };
  const source = parentThreadId ? { subagent: { thread_spawn: { parent_thread_id: parentThreadId, depth: 1 } } } : pick(["cli", "vscode", "exec", "review"]);
  push("session_meta", { id, cwd, source, originator: source === "exec" ? "codex_exec" : source === "vscode" ? "codex_vscode" : "codex_cli_rs", cli_version: "0.140.0", timestamp: iso(clock) });
  push("turn_context", { cwd, model, effort, approval_policy: "on-request", sandbox_policy: { type: "workspace-write" } });
  const total: CodexCounter = { cached_input_tokens: 0, input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
  let context = integer(9_000, 18_000);
  const turns = parentThreadId ? 1 : heavy(5, 0.7, 40);
  const children: number[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    clock += integer(20, 600) * 1000;
    push("event_msg", { type: "user_message", message: "[synthetic demo prompt]", images: [] });
    push("event_msg", { type: "task_started", model_context_window: 272_000 });
    const calls = heavy(parentThreadId ? 5 : 7, 0.7, 60);
    for (let call = 0; call < calls; call += 1) {
      clock += integer(2, 45) * 1000;
      const input = context + integer(200, 1_500);
      const cached = Math.round(input * between(0.82, 0.96));
      const output = heavy(380, 0.8, 9_000);
      const reasoning = Math.round(output * between(0.25, 0.65));
      const last = { cached_input_tokens: cached, input_tokens: input, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output };
      for (const key of Object.keys(total) as Array<keyof CodexCounter>) total[key] += last[key];
      push("event_msg", { type: "token_count", info: { total_token_usage: { ...total }, last_token_usage: last, model_context_window: 272_000 } });
      const callId = `call_${hex(24)}`;
      const kind = weighted([["exec_command", 52], ["apply_patch", 26], ["update_plan", 8], ["write_stdin", 6], ["skill", 3], ["none", 5]] as const);
      if (kind === "apply_patch") {
        push("response_item", { type: "custom_tool_call", name: "apply_patch", call_id: callId, input: "*** Begin Patch\n[synthetic]\n*** End Patch", status: "completed" });
      } else if (kind === "skill") {
        const skill = pick(codexSkills);
        push("response_item", { type: "function_call", name: "exec_command", call_id: callId, arguments: JSON.stringify({ cmd: `sed -n '1,200p' .agents/skills/${skill}/SKILL.md` }) });
      } else if (kind !== "none") {
        push("response_item", { type: "function_call", name: kind, call_id: callId, arguments: JSON.stringify({ cmd: "[synthetic]" }) });
      }
      if (kind !== "none") {
        clock += integer(1, 20) * 1000;
        push("response_item", { type: "function_call_output", call_id: callId, output: "[synthetic tool output]" });
      }
      context += integer(800, 4_000);
      if (context > 210_000) {
        push("event_msg", { type: "context_compacted" });
        context = integer(20_000, 34_000);
      }
      if (!parentThreadId && chance(0.012)) children.push(clock);
    }
    clock += integer(2, 20) * 1000;
    push("event_msg", { type: "agent_message", message: "[synthetic demo response]" });
    push("event_msg", { type: "task_complete", last_agent_message: "[synthetic]" });
  }
  // Older sessions have usually been archived; recent ones stay in the dated tree.
  const archived = now - start > 14 * DAY && chance(0.45);
  const stamp = iso(start).slice(0, 19).replace(/:/g, "-");
  const date = new Date(start);
  const path = archived
    ? join(archiveRoot, `rollout-${stamp}-${id}.jsonl`)
    : join(
        activeRoot,
        String(date.getUTCFullYear()),
        String(date.getUTCMonth() + 1).padStart(2, "0"),
        String(date.getUTCDate()).padStart(2, "0"),
        `rollout-${stamp}-${id}.jsonl`,
      );
  writeJsonl(path, records);
  for (const childStart of children) writeCodexSession(activeRoot, archiveRoot, repository, childStart, now, id);
  return id;
}

function writeCursorDatabase(path: string, sessions: Array<{ repository: Repository; start: number }>): void {
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB); CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);");
  const insert = database.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
  for (const { repository, start } of sessions) {
    const composerId = uuid();
    const bubbles = integer(4, 22);
    let clock = start;
    let costInCents = 0;
    for (let index = 0; index < bubbles; index += 1) {
      const bubbleId = uuid();
      const assistant = index % 2 === 1;
      const tool = assistant && chance(0.7)
        ? { name: pick(["read_file", "edit_file", "run_terminal_cmd", "codebase_search", "grep_search"]), toolCallId: `tool_${hex(16)}` }
        : null;
      const input = assistant ? integer(6_000, 48_000) : 0;
      const output = assistant ? heavy(320, 0.7, 4_000) : 0;
      costInCents += assistant ? Math.round(input * 0.0003 + output * 0.0015) : 0;
      clock += integer(10, 90) * 1000;
      insert.run(
        `bubbleId:${composerId}:${bubbleId}`,
        JSON.stringify({
          bubbleId,
          type: assistant ? 2 : 1,
          text: "[synthetic demo content]",
          ...(assistant ? { tokenCount: { inputTokens: input, outputTokens: output } } : {}),
          ...(tool ? { toolFormerData: tool } : {}),
        }),
      );
    }
    insert.run(
      `composerData:${composerId}`,
      JSON.stringify({
        composerId,
        createdAt: start,
        lastUpdatedAt: clock,
        status: "completed",
        originalModelLines: { [join(repository.root, pick(repository.files))]: [] },
        usageData: { [pick(["composer-1", "claude-4.5-sonnet", "gpt-5"])]: { amount: Math.ceil(bubbles / 2), costInCents } },
      }),
    );
  }
  database.close();
}

// ---------------------------------------------------------------------------
// Generate

function initializeRepository(root: string): void {
  mkdirSync(root, { recursive: true });
  try {
    execFileSync("git", ["init", "--quiet", root], { stdio: "ignore" });
  } catch {
    // Repository grouping only needs the `.git` marker.
    mkdirSync(join(root, ".git"), { recursive: true });
  }
}

function generate(root: string): { claudeRoot: string; codexRoot: string; codexArchiveRoot: string; cursorDatabase: string; home: string } {
  const claudeRoot = join(root, "claude", "projects");
  const codexRoot = join(root, "codex", "sessions");
  const codexArchiveRoot = join(root, "codex", "archived_sessions");
  const cursorDatabase = join(root, "cursor", "User", "globalStorage", "state.vscdb");
  const home = join(root, "home");
  for (const directory of [claudeRoot, codexRoot, codexArchiveRoot, home]) mkdirSync(directory, { recursive: true });

  const repositories: Repository[] = repositorySpecs.map((spec) => {
    const repository: Repository = { ...spec, directories: [...spec.directories], files: [...spec.files], root: join(root, "repos", spec.name) };
    initializeRepository(repository.root);
    for (const directory of repository.directories) mkdirSync(join(repository.root, directory), { recursive: true });
    return repository;
  });
  // A linked worktree, as created by `git worktree add` or a parallel-agent
  // orchestrator, is attributed to its main repository.
  const web = repositories[0];
  if (web) {
    const worktree = join(root, "worktrees", "acme-web-checkout-flow");
    mkdirSync(worktree, { recursive: true });
    mkdirSync(join(web.root, ".git", "worktrees", "acme-web-checkout-flow"), { recursive: true });
    writeFileSync(join(worktree, ".git"), `gitdir: ${join(web.root, ".git", "worktrees", "acme-web-checkout-flow")}\n`);
    web.directories.push(worktree);
  }

  const priced = rateCardModels();
  for (const [model] of [...claudeModels, ...claudeSubagentModels, ...codexModels]) {
    if (!priced.has(model)) process.stderr.write(`Demo model ${model} is not in data/rate-cards.json and will appear unpriced.\n`);
  }

  const now = Date.now();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const cursorSessions: Array<{ repository: Repository; start: number }> = [];
  let sessions = 0;
  for (let offset = DAYS - 1; offset >= 0; offset -= 1) {
    const day = new Date(today);
    day.setDate(today.getDate() - offset);
    const weekend = day.getDay() === 0 || day.getDay() === 6;
    // Usage ramps up over the window, as it does when a team adopts agents.
    const ramp = 0.55 + 0.45 * ((DAYS - offset) / DAYS);
    const count = Math.round((weekend ? between(0, 3) : between(4, 10)) * ramp);
    for (let index = 0; index < count; index += 1) {
      const start = sessionStart(day.valueOf());
      if (start > now) continue;
      const repository = weighted(repositories.map((item) => [item, item.weight] as const));
      const provider = weighted([["claude", 54], ["codex", 38], ["cursor", 8]] as const);
      if (provider === "claude") writeClaudeSession(claudeRoot, repository, start);
      else if (provider === "codex") writeCodexSession(codexRoot, codexArchiveRoot, repository, start, now);
      else cursorSessions.push({ repository, start });
      sessions += 1;
    }
  }
  writeCursorDatabase(cursorDatabase, cursorSessions);
  process.stderr.write(`Generated ${sessions} synthetic top-level sessions across ${repositories.length} repositories in ${root}\n`);
  return { claudeRoot, codexRoot, codexArchiveRoot, cursorDatabase, home };
}

// ---------------------------------------------------------------------------
// Run

async function portIsFree(candidate: number): Promise<boolean> {
  return await new Promise((resolvePort) => {
    const probe = createServer();
    probe.once("error", () => resolvePort(false));
    probe.listen(candidate, "127.0.0.1", () => probe.close(() => resolvePort(true)));
  });
}

if (!reportMode && !(await portIsFree(port))) {
  // Never fall through to "reuse the running dashboard": it may be showing real history.
  fail(`Port ${port} is already in use. Stop that process or pass --port with a free port.`);
}

const root = mkdtempSync(join(tmpdir(), "session-analytics-demo-"));
const keep = has("--keep");
const cleanup = (): void => {
  if (!keep) rmSync(root, { force: true, recursive: true });
};

let sources: ReturnType<typeof generate>;
try {
  sources = generate(root);
} catch (error) {
  cleanup();
  throw error;
}

const environment: NodeJS.ProcessEnv = {};
for (const [key, value] of Object.entries(process.env)) {
  if (/^(CLAUDE_CONFIG_DIR|CODEX_HOME|SESSION_ANALYTICS_|MACHINE_|CONDUCTOR_)/.test(key)) continue;
  environment[key] = value;
}
environment["HOME"] = sources.home;

const sourceFlags = [
  "--claude-root", sources.claudeRoot,
  "--codex-root", sources.codexRoot,
  "--codex-archive-root", sources.codexArchiveRoot,
  "--cursor-database", sources.cursorDatabase,
  "--database", join(root, "conductor-not-present.db"),
];
const childArguments = reportMode
  ? [bin, "report", ...sourceFlags, ...(has("--json") ? ["--json"] : [])]
  : [bin, "dashboard", ...sourceFlags, "--port", String(port), ...(has("--no-open") ? ["--no-open"] : [])];

const child = spawn(process.execPath, childArguments, { env: environment, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => child.kill(signal));
}
child.once("exit", (code, signal) => {
  cleanup();
  if (keep) process.stderr.write(`Synthetic data kept in ${root}\n`);
  process.exit(code ?? (signal ? 0 : 1));
});
