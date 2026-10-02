import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AnalyzeOptions } from "../types.ts";
import type { McpInventoryProvider } from "./types.ts";
import { record, safeName } from "./names.ts";

const MAX_NAMES = 512;
const MAX_BYTES = 1_048_576;

/** Inventory is names only: skill bodies, commands, URLs, env and credentials are never projected. */
async function boundedText(path: string): Promise<string | null> {
  let file;
  try {
    file = await open(path, "r");
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_BYTES) throw new Error("Inventory source unavailable.");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await file.read(buffer, size, buffer.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > MAX_BYTES) throw new Error("Inventory source unavailable.");
    return buffer.subarray(0, size).toString("utf8");
  } catch (error) {
    if (record(error)?.["code"] === "ENOENT") return null;
    throw new Error("Inventory source unavailable.");
  } finally { await file?.close(); }
}

/** A conservative names-only TOML reader, not a configuration interpreter. */
export function tomlServerNames(text: string): string[] {
  const names = new Set<string>();
  let multiline: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    let line = "", quote: string | null = null;
    for (let index = 0; index < raw.length; index += 1) {
      const character = raw[index]!;
      if (multiline) {
        if (raw.slice(index, index + 3) === multiline) { multiline = null; index += 2; }
        continue;
      }
      if (quote) {
        line += character;
        if (character === "\\" && quote === '"') { line += raw[++index] ?? ""; continue; }
        if (character === quote) quote = null;
        continue;
      }
      if (character === "#") break;
      if (raw.slice(index, index + 3) === '"""' || raw.slice(index, index + 3) === "'''") {
        multiline = raw.slice(index, index + 3); index += 2; line += " "; continue;
      }
      if (character === '"' || character === "'") quote = character;
      line += character;
    }
    // Only actual [mcp_servers.NAME] declarations, including quoted keys.
    const header = /^\s*\[\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*\.\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*\]\s*$/.exec(line);
    const key = header?.[1];
    if (!key) continue;
    let name: unknown = key;
    try {
      if (key.startsWith('"')) name = JSON.parse(key);
      else if (key.startsWith("'")) name = key.slice(1, -1);
    } catch { continue; }
    const safe = safeName(name);
    if (safe) names.add(safe);
  }
  return [...names].sort();
}

export async function launchProjectDirectory(cwd: string): Promise<string> {
  let directory = resolve(cwd);
  while (true) {
    try { if (await stat(join(directory, ".git"))) return directory; } catch { /* ascend */ }
    const parent = dirname(directory);
    if (parent === directory) return resolve(cwd);
    directory = parent;
  }
}

async function profiles(home: string, name: string, override?: string): Promise<string[]> {
  const result = new Set([join(home, name), ...(override ? [resolve(override)] : [])]);
  try {
    for (const item of (await readdir(home, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (result.size >= 64) break;
      if (item.name.startsWith(`${name}-`) && (item.isDirectory() || item.isSymbolicLink())) result.add(join(home, item.name));
    }
  } catch { /* Defaults remain usable. */ }
  return [...result];
}

export async function readInventory(
  options: AnalyzeOptions,
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): Promise<McpInventoryProvider[]> {
  const project = await launchProjectDirectory(options.repositoryRoot ?? options.mcpCwd ?? process.cwd());
  const claude = options.claudeRoot ? [dirname(resolve(options.claudeRoot))]
    : [...await profiles(home, ".claude", environment["CLAUDE_CONFIG_DIR"]), join(home, ".config/claude")];
  const codex = options.codexRoot || options.codexArchiveRoot
    ? [...new Set([options.codexRoot, options.codexArchiveRoot].filter((v): v is string => Boolean(v)).map((v) => dirname(resolve(v))))]
    : await profiles(home, ".codex", environment["CODEX_HOME"]);
  const inventory: McpInventoryProvider[] = [];
  for (const provider of ["claude", "codex", "cursor"] as const) {
    const value: McpInventoryProvider = { provider, skills: [], mcpServers: [], sourcesRead: 0, unreadableSources: 0, truncated: false };
    const skills = new Set<string>(), servers = new Set<string>(), seen = new Set<string>();
    const add = (set: Set<string>, name: unknown): void => {
      const safe = safeName(name);
      if (!safe) return;
      if (set.size < MAX_NAMES) set.add(safe);
      else if (!set.has(safe)) value.truncated = true;
    };
    const once = async (path: string): Promise<boolean> => {
      let canonical = resolve(path);
      try { canonical = await realpath(path); } catch { /* handled by reader */ }
      if (seen.has(canonical)) return false;
      seen.add(canonical); return true;
    };
    const skillDirectory = async (path: string): Promise<void> => {
      if (!await once(path)) return;
      try {
        const entries = (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
        value.sourcesRead += 1;
        if (entries.length > 2048) value.truncated = true;
        for (const entry of entries.slice(0, 2048)) {
          if (!safeName(entry.name) || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
          try { if ((await stat(join(path, entry.name, "SKILL.md"))).isFile()) add(skills, entry.name); } catch { /* not a skill */ }
        }
      } catch (error) { if (record(error)?.["code"] !== "ENOENT") value.unreadableSources += 1; }
    };
    const config = async (path: string, toml = false): Promise<void> => {
      if (!await once(path)) return;
      try {
        const text = await boundedText(path);
        if (text === null) return;
        if (toml) {
          for (const name of tomlServerNames(text)) add(servers, name);
        } else {
          const data = record(JSON.parse(text));
          if (!data) throw new Error("Invalid inventory.");
          const maps = [record(data["mcpServers"])];
          // Claude's local registration is keyed by project path. The key is used only for lookup.
          const projects = record(data["projects"]);
          for (const directory of new Set([project, options.mcpCwd].filter((v): v is string => Boolean(v)))) {
            maps.push(record(record(projects?.[directory])?.["mcpServers"]));
          }
          for (const map of maps) for (const [name, entry] of Object.entries(map ?? {})) if (record(entry)) add(servers, name);
        }
        value.sourcesRead += 1;
      } catch { value.unreadableSources += 1; }
    };
    const shared = provider === "codex" ? [join(project, ".agents/skills")] : [];
    const explicit = provider === "claude" ? options.claudeRoot : provider === "codex"
      ? options.codexRoot || options.codexArchiveRoot : options.cursorDatabasePath;
    if (!explicit && provider === "codex") shared.push(join(home, ".agents/skills"));
    for (const path of shared) await skillDirectory(path);
    if (provider === "claude") {
      for (const profile of claude) {
        await skillDirectory(join(profile, "skills"));
        await config(join(profile, ".claude.json"));
        await config(`${profile}.json`);
      }
      await skillDirectory(join(project, ".claude/skills"));
      await config(join(project, ".mcp.json"));
    } else if (provider === "codex") {
      for (const profile of codex) {
        await skillDirectory(join(profile, "skills"));
        await skillDirectory(join(profile, "skills/.system"));
        await config(join(profile, "config.toml"), true);
      }
      await skillDirectory(join(project, ".codex/skills"));
      await config(join(project, ".codex/config.toml"), true);
    } else {
      if (!explicit) { await skillDirectory(join(home, ".cursor/skills")); await config(join(home, ".cursor/mcp.json")); }
      await skillDirectory(join(project, ".cursor/skills"));
      await config(join(project, ".cursor/mcp.json"));
    }
    value.skills = [...skills].sort(); value.mcpServers = [...servers].sort();
    inventory.push(value);
  }
  return inventory;
}
