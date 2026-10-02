import { createHmac } from "node:crypto";
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

/** Object-key order is normalized; string values (including command quoting) are preserved. */
export function fingerprint(key: Buffer | null, domain: string, value: unknown): string | null {
  if (!key || value === undefined) return null;
  let entries = 0, bytes = 0;
  function canonical(item: unknown, depth: number): string {
    if (++entries > 10_000 || depth > 16) throw new Error("Bounded hashing.");
    if (item === null || typeof item !== "object") {
      const result = JSON.stringify(item) ?? "null";
      bytes += result.length;
      if (bytes > 1_048_576) throw new Error("Bounded hashing.");
      return result;
    }
    if (Array.isArray(item)) return `[${item.map((v) => canonical(v, depth + 1)).join(",")}]`;
    return `{${Object.keys(item).sort().map((k) => `${canonical(k, depth + 1)}:${canonical(record(item)[k], depth + 1)}`).join(",")}}`;
  }
  try { return createHmac("sha256", key).update(domain).update("\0").update(canonical(value, 0)).digest("hex"); }
  catch { return null; }
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
    return shellClass(argv.map((v) => `'${v.replaceAll("'", "")}'`).join(" "));
  }
  if (typeof command !== "string" || command.length > 65_536) return "shell";
  const tokens = command.match(/"[^"\n]*"|'[^'\n]*'|&&|\|\||[;|\n]|[^\s;&|]+/g) ?? [];
  if (tokens.some((t) => /[$`<>\\]/.test(t))) return "shell";
  const segments: string[][] = [[]];
  for (const token of tokens) {
    if (["&&", ";", "\n"].includes(token)) segments.push([]);
    else if (["|", "||"].includes(token)) return "shell";
    else segments.at(-1)?.push(token.replace(/^(["'])(.*)\1$/, "$2"));
  }
  const classes: ToolClass[] = [];
  for (const words of segments) {
    if (words[0] === "env") words.shift();
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) words.shift();
    const executable = basename(words[0] ?? "").toLowerCase();
    const args = words.slice(1);
    if (!executable || executable === "cd") continue;
    if (["git", "gh", "hg", "svn"].includes(executable)) classes.push("vcs");
    else if (["rg", "grep", "find", "fd", "ag"].includes(executable)) classes.push("search");
    else if (["cat", "head", "tail", "ls", "pwd", "wc", "stat"].includes(executable) || (executable === "sed" && !args.some((a) => /^-.*i/.test(a)))) classes.push("read");
    else if (["pytest", "jest", "vitest", "tsc", "eslint", "ruff", "mypy", "make", "cmake", "ninja", "xcodebuild", "mvn", "gradle", "gradlew"].includes(executable) ||
      (["npm", "pnpm", "yarn", "bun"].includes(executable) && /^(?:run )?(?:test(?::[\w-]+)?|check|typecheck|lint|build)(?: |$)/.test(args.join(" "))) ||
      (["cargo", "go", "dotnet"].includes(executable) && ["test", "build", "check", "clippy", "vet"].includes(args[0] ?? "")) ||
      (["python", "python3"].includes(executable) && args[0] === "-m" && ["pytest", "unittest"].includes(args[1] ?? "")) ||
      (executable === "node" && args.includes("--test"))) classes.push("test_build");
    else classes.push("shell");
  }
  return classes.length && classes.every((c) => c === classes[0]) ? classes[0]! : "shell";
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

export function fileFingerprints(key: Buffer | null, args: unknown, cwd: string): string[] {
  if (!key) return [];
  const value = record(args);
  const workdir = text(value["workdir"]);
  if (workdir) cwd = resolve(cwd, workdir);
  const paths: string[] = [];
  for (const property of ["file_path", "path"]) if (typeof value[property] === "string") paths.push(value[property] as string);
  // Codex FileChange carries path-keyed changes; retain only hashed paths.
  for (const path of Object.keys(record(value["changes"]))) paths.push(path);
  if (typeof args === "string" && args.length <= 1_048_576) {
    for (const match of args.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) paths.push(match[1]!);
  }
  return [...new Set(paths.slice(0, 1000).flatMap((path) => {
    const hash = fingerprint(key, "file", resolve(cwd, path));
    return hash ? [hash] : [];
  }))];
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
