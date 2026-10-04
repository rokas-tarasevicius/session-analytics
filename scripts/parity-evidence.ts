/** Audit-only source generations. Reads metadata, never transcript content; returns hashes only. */
import { createHash } from "node:crypto";
import { opendir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "../verify/shared/sqlite.ts";
import { discoverProviderRoots } from "../src/analyzer.ts";
import type { AnalyzeOptions } from "../src/types.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sessionKey = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 12);

export async function evidenceGenerations(options: AnalyzeOptions): Promise<Map<string, string>> {
  const discovered = await discoverProviderRoots({ home: homedir(), claudeConfigDirectory: process.env["CLAUDE_CONFIG_DIR"], codexHome: process.env["CODEX_HOME"] });
  const roots = {
    claude: options.claudeRoot ? [options.claudeRoot] : discovered.claude,
    codex: options.codexRoot || options.codexArchiveRoot ? [options.codexRoot, options.codexArchiveRoot].filter((r): r is string => !!r) : discovered.codex,
  };
  const groups = new Map<string, string[]>();
  const walk = async (root: string, provider: string): Promise<void> => {
    let directory;
    try { directory = await opendir(root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for await (const entry of directory) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) { await walk(path, provider); continue; }
      if (!entry.isFile() || !/\.(jsonl|json)$/.test(entry.name)) continue;
      const child = provider === "claude" ? path.match(/\/([0-9a-f]{8}-[0-9a-f-]{27})\/subagents\//i)?.[1] : null;
      const id = child ?? basename(path).match(/([0-9a-f]{8}-[0-9a-f-]{27})\.(?:jsonl|json)$/i)?.[1];
      if (!id) continue;
      const key = `${provider}:${id}`;
      let version: string;
      try {
        const info = await stat(path, { bigint: true });
        version = hash([path, ...[info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String)]);
      } catch { version = hash([path, "unavailable"]); }
      groups.set(key, [...groups.get(key) ?? [], version]);
    }
  };
  for (const provider of ["claude", "codex"] as const) for (const root of roots[provider]) await walk(root, provider);
  const versions = new Map([...groups].map(([id, parts]) => [id, hash(parts.sort())]));
  const result = new Map([...versions].map(([id, version]) => [sessionKey(id), version]));
  const path = options.databasePath ?? join(homedir(), "Library/Application Support/com.conductor.app/conductor.db");
  try { await stat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return result; throw error; }
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    // Match the analyzer's metadata dependencies; unknown columns and message tables are never read.
    const rows = (table: string, fields: string[]) => {
      const columns = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((r) => String(r["name"])));
      return database.prepare(`SELECT ${fields.filter((field) => columns.has(field)).join(",")} FROM ${table}`).all();
    };
    const repositories = new Map(rows("repos", ["id", "name", "root_path", "remote_url", "default_branch", "hidden"]).map((r) => [r["id"], r]));
    const workspaces = new Map(rows("workspaces", ["id", "repository_id", "workspace_name", "workspace_path", "branch", "archive_commit", "pr_title", "derived_status"]).map((r) => [r["id"], r]));
    for (const row of rows("sessions", ["id", "status", "agent_type", "title", "created_at", "updated_at", "claude_session_id", "model", "is_hidden", "workspace_id"])) {
      const version = versions.get(`${row["agent_type"]}:${row["claude_session_id"]}`);
      if (!version) continue;
      const workspace = workspaces.get(row["workspace_id"]), repository = repositories.get(workspace?.["repository_id"] ?? null);
      result.set(sessionKey(String(row["id"])), hash([version, row, workspace, repository]));
    }
  } finally { database.close(); }
  return result;
}

export function changedEvidence(...generations: Map<string, string>[]): Set<string> {
  const keys = new Set(generations.flatMap((generation) => [...generation.keys()]));
  return new Set([...keys].filter((key) => new Set(generations.map((generation) => generation.get(key))).size > 1));
}
