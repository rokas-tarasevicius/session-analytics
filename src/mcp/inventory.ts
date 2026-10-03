import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { AnalyzeOptions } from "../types.ts";
import type { McpInventoryProvider } from "./types.ts";
import { record, safeName } from "./names.ts";

const MAX_NAMES = 512;
const MAX_BYTES = 1_048_576;

/** Inventory is names only: skill bodies, commands, URLs, env and credentials are never projected. */
async function boundedText(path: string, prefixOnly = false): Promise<string | null> {
  let file;
  try {
    file = await open(path, "r");
    const info = await file.stat();
    if (!info.isFile() || (!prefixOnly && info.size > MAX_BYTES)) throw new Error("Inventory source unavailable.");
    const buffer = Buffer.alloc(prefixOnly ? 16_384 : MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await file.read(buffer, size, buffer.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > MAX_BYTES) throw new Error("Inventory source unavailable.");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
  } catch (error) {
    if (record(error)?.["code"] === "ENOENT") return null;
    throw new Error("Inventory source unavailable.");
  } finally { await file?.close(); }
}

/** A conservative names-only TOML reader, not a configuration interpreter. */
export function tomlServerNames(text: string): string[] {
  const names = new Set<string>();
  let multiline: string | null = null;
  const invalid = (): never => { throw new Error("Inventory source unavailable."); };
  const escapeEnd = (raw: string, index: number, multi: boolean): number => {
    const next = raw[index + 1];
    if (multi && /^[\t ]*$/.test(raw.slice(index + 1))) return raw.length;
    if (next && '"\\btnfr'.includes(next)) return index + 1;
    if (next === "u" || next === "U") {
      const digits = next === "u" ? 4 : 8, hex = raw.slice(index + 2, index + 2 + digits);
      if (hex.length !== digits || !/^[a-f0-9]+$/i.test(hex)) return invalid();
      const code = Number.parseInt(hex, 16);
      if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return invalid();
      return index + 1 + digits;
    }
    return invalid();
  };
  for (const raw of text.split(/\r?\n/)) {
    // A continuation/closing line is never a table declaration.
    let line = multiline ? "value " : "", quote: string | null = null;
    for (let index = 0; index < raw.length; index += 1) {
      const character = raw[index]!;
      if (multiline) {
        if (character === "\\" && multiline === '"""') { index = escapeEnd(raw, index, true); continue; }
        if (character === multiline[0]) {
          let end = index;
          while (raw[end] === character) end += 1;
          const length = end - index;
          if (length > 5) invalid();
          if (length >= 3) multiline = null;
          index = end - 1;
        }
        continue;
      }
      if (quote) {
        line += character;
        if (character === "\\" && quote === '"') {
          const end = escapeEnd(raw, index, false);
          line += raw.slice(index + 1, end + 1); index = end; continue;
        }
        if (character === quote) quote = null;
        continue;
      }
      if (character === "#") break;
      if (raw.slice(index, index + 3) === '"""' || raw.slice(index, index + 3) === "'''") {
        multiline = raw.slice(index, index + 3); index += 2; line += "value "; continue;
      }
      if (character === '"' || character === "'") quote = character;
      line += character;
    }
    if (quote) invalid();
    // Only actual [mcp_servers.NAME] declarations, including quoted keys.
    const header = /^\s*\[\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*\.\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*\]\s*$/.exec(line);
    const key = header?.[1];
    if (!key) continue;
    let name: unknown = key;
    try {
      if (key.startsWith('"')) name = JSON.parse(key);
      else if (key.startsWith("'")) name = key.slice(1, -1);
    } catch { invalid(); }
    const safe = safeName(name);
    if (safe) names.add(safe);
  }
  if (multiline) invalid();
  return [...names].sort();
}

/** Read only a small frontmatter prefix. Unsupported YAML is an unknown identity. */
function frontmatterName(text: string, fallback: string): string | null {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return safeName(fallback);
  const end = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)\s*$/.test(line));
  if (end < 0) return null;
  const scalar = (raw: string): string | null => {
    if (raw.startsWith('"')) {
      const match = /^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/.exec(raw);
      try { return match ? JSON.parse(match[1]!) as string : null; } catch { return null; }
    }
    if (raw.startsWith("'")) return /^'(?:[^']|'')*'\s*(?:#.*)?$/.test(raw)
      ? raw.slice(1, raw.lastIndexOf("'")).replaceAll("''", "'") : null;
    return /^[!&*[{]/.test(raw) ? null : raw.replace(/\s+#.*$/, "").trim();
  };
  let name: string | undefined;
  let previousKey: string | null = null;
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (/^\s/.test(line)) {
      // Indented values may belong to another field's block/nested mapping;
      // a continued name or an indented root is outside our supported subset.
      if (previousKey === null || previousKey === "name") return null;
      continue;
    }
    const field = /^(name|[A-Za-z][A-Za-z0-9_-]*|"[^"\\]+"|'[^']+'):\s*(.*)$/.exec(line);
    if (!field) return null;
    const key = scalar(field[1]!), raw = field[2]!;
    if (key === null) return null;
    previousKey = key;
    const value = scalar(raw);
    if (value === null) return null;
    if (key === "name") {
      if (name !== undefined || !safeName(value)) return null;
      name = value;
    }
  }
  return name ?? safeName(fallback);
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
    const value: McpInventoryProvider = { provider, skills: [], skillIdentities: [], unresolvedSkills: 0, mcpServers: [], sourcesRead: 0, unreadableSources: 0, truncated: false };
    const skills = new Set<string>(), servers = new Set<string>(), seen = new Set<string>();
    const identities = new Map<string, { name: string | null; aliases: Set<string> }>();
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
          try {
            const file = await realpath(join(path, entry.name, "SKILL.md"));
            const previous = identities.get(file);
            if (previous) {
              if (previous.aliases.size < MAX_NAMES) previous.aliases.add(entry.name);
              else value.truncated = true;
              continue;
            }
            if (identities.size >= MAX_NAMES) { value.truncated = true; continue; }
            const identity: { name: string | null; aliases: Set<string> } = { name: null, aliases: new Set([entry.name]) };
            identities.set(file, identity);
            const text = await boundedText(file, true);
            const name = text === null ? null : frontmatterName(text, basename(dirname(file)));
            identity.name = name;
            if (name) { identity.aliases.add(name); add(skills, name); }
            else value.unresolvedSkills! += 1;
          } catch (error) {
            if (record(error)?.["code"] !== "ENOENT") { value.unreadableSources += 1; value.unresolvedSkills! += 1; }
          }
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
    value.skillIdentities = [...identities.values()].filter((item): item is { name: string; aliases: Set<string> } => item.name !== null)
      .map((item) => ({ name: item.name, aliases: [...item.aliases].sort() })).sort((a, b) => a.name.localeCompare(b.name));
    inventory.push(value);
  }
  return inventory;
}
