import { createHash, createHmac } from "node:crypto";
import { basename, resolve } from "node:path";
import type { ErrorClass, ToolClass } from "./reliability-types.ts";

export type RecordValue = Record<string, unknown>;
export const record = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
export const text = (value: unknown): string | null => typeof value === "string" ? value : null;
export const nonnegative = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
export const name = (value: unknown, fallback = "unknown"): string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) ? value : fallback;
export const timestamp = (value: unknown): number | null => {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};
export function argumentsValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value.length > 1_048_576) return undefined;
  try { return JSON.parse(value); } catch { return value; }
}

export interface HashBudget { bytes: number; references: number; exhausted: boolean }
export const hashBudget = (): HashBudget => ({ bytes: 32 * 1024 * 1024, references: 16_384, exhausted: false });

/** Object-key order is normalized; string values (including command quoting) are preserved. */
export function fingerprint(key: Buffer | null, domain: string, value: unknown, budget?: HashBudget): string | null {
  if (!key || value === undefined) return null;
  if (budget?.exhausted) return null;
  let entries = 0, bytes = 0;
  function charge(length: number): void {
    bytes += length;
    if (bytes > 1_048_576 || (budget && length * 2 > budget.bytes)) throw new Error("Bounded hashing.");
    if (budget) budget.bytes -= length * 2;
  }
  function canonical(item: unknown, depth: number): string {
    if (++entries > 10_000 || depth > 16) throw new Error("Bounded hashing.");
    if (item === null || typeof item !== "object") {
      // Check before allocating an escaped copy of a large string.
      if (typeof item === "string") charge(item.length);
      const result = JSON.stringify(item) ?? "null";
      charge(result.length - (typeof item === "string" ? item.length : 0));
      return result;
    }
    charge(2);
    if (Array.isArray(item)) {
      const values: string[] = [];
      for (const value of item) { charge(1); values.push(canonical(value, depth + 1)); }
      return `[${values.join(",")}]`;
    }
    const keys: string[] = [];
    for (const k in item) if (Object.hasOwn(item, k)) {
      if (keys.length >= 10_000) throw new Error("Bounded hashing.");
      charge(2); keys.push(k);
    }
    return `{${keys.sort().map((k) => `${canonical(k, depth + 1)}:${canonical(record(item)[k], depth + 1)}`).join(",")}}`;
  }
  try { return createHmac("sha256", key).update(domain).update("\0").update(canonical(value, 0)).digest("hex"); }
  catch { if (budget) budget.exhausted = true; return null; }
}

/** Normalize Claude, direct Codex and typed MCP identities without truncation collisions. */
export function toolIdentity(raw: string, explicitServer?: string | null): { tool: string; server: string | null } {
  const qualified = /^(?:functions\.)?mcp__(.+?)__(.+)$/.exec(raw);
  const server = explicitServer ? name(explicitServer) : qualified ? name(qualified[1]) : null;
  if (!server) return { tool: name(raw), server: null };
  const tool = name(qualified?.[2] ?? raw);
  const identity = `mcp__${server}__${tool}`;
  return { server, tool: identity.length <= 128 ? identity : `${identity.slice(0, 110)}__${createHash("sha256").update(identity).digest("hex").slice(0, 16)}` };
}

const namedClasses: Record<string, ToolClass> = {
  read: "read", read_file: "read", view_image: "read", glob: "search", grep: "search", search: "search", search_code: "search", codebase_search: "search", grep_search: "search",
  edit: "edit", multiedit: "edit", edit_file: "edit", apply_patch: "edit", filechange: "edit", write: "write", write_file: "write",
  bash: "shell", exec_command: "shell", commandexecution: "shell", shell: "shell", shell_command: "shell", run_terminal_cmd: "shell",
  webfetch: "web", websearch: "web", web_search: "web", web: "web",
  agent: "delegate", task: "delegate", spawn_agent: "delegate", send_message: "delegate", wait_agent: "delegate",
  todowrite: "plan", update_plan: "plan", exitplanmode: "plan", enterplanmode: "plan",
};

/** Conservative argv classifier. No evaluation, interpolation, shell execution or script inspection. */
export function shellClass(command: unknown): ToolClass {
  // Current Codex CommandExecution records argv, commonly ["/bin/zsh", "-lc", body].
  // Unwrap only that explicit shape; no shell evaluation or inference from output.
  if (Array.isArray(command) && command.every((v) => typeof v === "string")) {
    const argv = command as string[];
    if (["bash", "sh", "zsh"].includes(basename(argv[0] ?? "")) && ["-lc", "-c"].includes(argv[1] ?? "") && argv.length === 3) return shellClass(argv[2]);
    return commandClass(argv);
  }
  if (typeof command !== "string" || command.length > 65_536) return "shell";
  const tokens = command.match(/"[^"\n]*"|'[^'\n]*'|&&|\|\||[;&|\n]|[^\s;&|]+/g) ?? [];
  if (tokens.some((t) => /[$`<>\\]/.test(t))) return "shell";
  const segments: string[][] = [[]];
  for (const token of tokens) {
    if (["&&", ";", "\n"].includes(token)) segments.push([]);
    else if (["&", "|", "||"].includes(token)) return "shell";
    else segments.at(-1)?.push(token.replace(/^(["'])(.*)\1$/, "$2"));
  }
  const classes = segments.filter((words) => words.length && words[0] !== "cd").map(commandClass);
  return classes.length && classes.every((c) => c === classes[0]) ? classes[0]! : "shell";
}

function commandClass(input: string[]): ToolClass {
  const words = [...input];
  if (words[0] === "env") words.shift();
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) words.shift();
  const executable = basename(words[0] ?? "").toLowerCase();
  const args = words.slice(1);
  if (["git", "gh", "hg", "svn"].includes(executable)) return "vcs";
  if (["rg", "grep", "find", "fd", "ag"].includes(executable)) return "search";
  if (["cat", "head", "tail", "ls", "pwd", "wc", "stat"].includes(executable) || (executable === "sed" && !args.some((a) => /^-.*i/.test(a)))) return "read";
  if (args.some((a) => /^(?:--?(?:help|version|clean|watch|dry-run|listTests|collect-only|list|showConfig|listFilesOnly|init|fixtures|fixtures-per-test|markers|trace-config|print-config|env-info|inspect-config)|-[hV]|help|version|clean|distclean|mrproper|-list|-show\w+)(?:=|$)/.test(a)) ||
    (executable === "tsc" && args.includes("-v")) || (executable === "ninja" && args.includes("-t")) ||
    (["make", "ninja", "mvn", "gradle", "gradlew"].includes(executable) && args.some((a) => /^-[^-]*[nq]/.test(a)))) return "shell";
  const targets = args.filter((a) => !a.startsWith("-") && !/^\d+$/.test(a));
  if (["pytest", "jest", "vitest", "tsc", "eslint", "mypy"].includes(executable) ||
    (executable === "ruff" && args[0] === "check") ||
    (["make", "ninja"].includes(executable) && targets.length > 0 && targets.every((a) => /^(?:all|test|check|build|lint|typecheck)(?::[\w-]+)?$/.test(a))) ||
    (executable === "cmake" && args[0] === "--build" && args.length > 1) ||
    (executable === "xcodebuild" && args.some((a) => ["test", "build", "analyze"].includes(a))) ||
    (["mvn", "gradle", "gradlew"].includes(executable) && targets.length > 0 && targets.every((a) => ["test", "verify", "package", "compile", "build", "check", "testClasses"].includes(a))) ||
    (["npm", "pnpm", "yarn", "bun"].includes(executable) && /^(?:run )?(?:test(?::[\w-]+)?|check|typecheck|lint|build)(?: |$)/.test(args.join(" "))) ||
    (["cargo", "go", "dotnet"].includes(executable) && ["test", "build", "check", "clippy", "vet"].includes(args[0] ?? "")) ||
    (["python", "python3"].includes(executable) && args[0] === "-m" && ["pytest", "unittest"].includes(args[1] ?? "")) ||
    (executable === "node" && args.includes("--test"))) return "test_build";
  return "shell";
}

export function classifyTool(tool: string, args: unknown, parsed: unknown, contentRules: boolean): ToolClass {
  if (/^(?:functions\.)?mcp__/.test(tool)) return "mcp";
  const short = tool.split(".").at(-1)?.toLowerCase() ?? "";
  const base = Object.hasOwn(namedClasses, short) ? namedClasses[short]! : tool.startsWith("web.") ? "web" : "other";
  if (base !== "shell") return base;
  if (Array.isArray(parsed) && parsed.length > 0) {
    const kinds = parsed.map((p) => record(p)["type"]);
    if (kinds.every((k) => k === "read" || k === "list_files")) return "read";
    if (kinds.every((k) => k === "search")) return "search";
  }
  return contentRules ? shellClass(record(args)["cmd"] ?? record(args)["command"]) : base;
}

export function fileFingerprints(key: Buffer | null, args: unknown, cwd: string, parsed?: unknown, budget?: HashBudget): string[] {
  if (!key || budget?.exhausted) return [];
  const value = record(args);
  const workdir = text(value["workdir"]);
  if (workdir) cwd = resolve(cwd, workdir);
  function* paths(): Generator<string> {
    for (const property of ["file_path", "path"]) if (typeof value[property] === "string") yield value[property] as string;
    const changes = record(value["changes"]);
    for (const path in changes) if (Object.hasOwn(changes, path)) yield path;
    if (Array.isArray(parsed)) for (const entry of parsed) {
      const command = record(entry);
      if (command["type"] === "read" && typeof command["path"] === "string") yield command["path"];
    }
    if (typeof args === "string" && args.length <= 1_048_576) for (const match of args.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) yield match[1]!;
  }
  const hashes = new Set<string>();
  let references = 0;
  for (const path of paths()) {
    if (++references > 1000 || (budget && budget.references <= 0) || path.length + cwd.length > 65_536) { if (budget) budget.exhausted = true; break; }
    if (budget) budget.references -= 1;
    const hash = fingerprint(key, "file", resolve(cwd, path), budget);
    if (hash) hashes.add(hash);
    if (budget?.exhausted) break;
  }
  return [...hashes];
}

/** Runs only over an already-failed tool result, and only with P2 enabled. */
export function errorFromText(value: string, toolClass: ToolClass): ErrorClass | null {
  const input = value.slice(0, 65_536).toLowerCase();
  if (/hook (?:blocked|prevented)|blocked by.*hook/.test(input)) return "hook_blocked";
  if (/permission.*(?:denied|reject)|not allowed|sandbox.*(?:denied|blocked)/.test(input)) return "permission_denied_policy";
  if (/timed? ?out|timeout/.test(input)) return "timeout";
  if (/interrupt(?:ed|ion)|cancelled by user/.test(input)) return "interrupted";
  if (/command not found|not recognized as an? (?:internal|external) command/.test(input)) return "command_not_found";
  if ((toolClass === "edit" || toolClass === "write") && /(?:old.?string|string to replace|anchor|expected lines|search block).*(?:not found|not match|could not find)|failed to find expected/.test(input)) return "edit_anchor_mismatch";
  if (/no such file|file not found|enoent/.test(input)) return "not_found";
  if (/rate.?limit|too many requests|http 429/.test(input)) return "api_rate_limit";
  if (/internal server error|http 50[0234]|service unavailable/.test(input)) return "api_server_error";
  return null;
}
