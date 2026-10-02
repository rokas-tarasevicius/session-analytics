import { createReadStream } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { WorkflowInventory, WorkflowSkill } from "./workflow-types.ts";
import { workflowName, workflowTimestamp } from "./workflow.ts";
import type { WorkflowHistory } from "./workflow.ts";

export interface WorkflowSources {
  inventory: WorkflowInventory;
  /** Internal only: keyed by the raw provider session ID; never serialized. */
  historyByProfile: Map<string, WorkflowHistory>;
}
const emptyInventory = (): WorkflowInventory => ({ skills: [], directoriesRead: 0, directoriesUnavailable: 0, historyFilesRead: 0, historyFilesUnavailable: 0, malformedHistoryRecords: 0 });

/** Take the whole leading slash-command token, never a partial match or arguments. */
export function slashCommand(display: unknown): string | null {
  if (typeof display !== "string" || display.length === 0 || display[0] !== "/") return null;
  const token = display.match(/^\/([^\s]+)(?:\s|$)/)?.[1];
  const name = workflowName(token);
  return name ? `/${name}` : null;
}

async function history(path: string, inventory: WorkflowInventory): Promise<WorkflowHistory> {
  const commands: WorkflowHistory["commands"] = new Map();
  const seen = new Set<string>();
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let row: Record<string, unknown>;
      try { row = JSON.parse(line) as Record<string, unknown>; }
      catch { inventory.malformedHistoryRecords += 1; continue; }
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const name = slashCommand(row.display), time = workflowTimestamp(row.timestamp);
      if (!name || time === null || typeof row.sessionId !== "string" || row.sessionId.length > 256) continue;
      const key = JSON.stringify([row.sessionId, time, name]);
      if (seen.has(key)) continue;
      seen.add(key);
      const events = commands.get(row.sessionId) ?? [];
      events.push({ name, at: new Date(time).toISOString() }); commands.set(row.sessionId, events);
    }
    inventory.historyFilesRead += 1;
    return { commands, available: true };
  } catch {
    inventory.historyFilesUnavailable += 1;
    return { commands: new Map(), available: false };
  } finally { lines.close(); input.destroy(); }
}

async function skills(path: string, provider: "claude" | "codex", repositoryId: string | null, inventory: WorkflowInventory, seen: Set<string>): Promise<void> {
  try {
    const canonical = await realpath(path), key = `${provider}:${repositoryId}:${canonical}`;
    if (seen.has(key)) return;
    seen.add(key);
    const entries = await readdir(path, { withFileTypes: true });
    inventory.directoriesRead += 1;
    for (const entry of entries) {
      if (entry.name === ".system" && entry.isDirectory()) { await skills(join(path, entry.name), provider, repositoryId, inventory, seen); continue; }
      const name = workflowName(entry.name);
      if (!name || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
      // Only existence is read. Skill bodies, frontmatter and symlink targets
      // never become public fields; linked skill installations are supported.
      try {
        if ((await stat(join(path, entry.name, "SKILL.md"))).isFile()) inventory.skills.push({ name, provider, repositoryId });
      } catch { /* A broken skill link is not an installed skill. */ }
    }
  } catch { inventory.directoriesUnavailable += 1; }
}

export async function loadWorkflowSources(claudeRoots: string[], codexRoots: string[], sharedSkills?: string): Promise<WorkflowSources> {
  const inventory = emptyInventory(), historyByProfile = new Map<string, WorkflowHistory>(), seen = new Set<string>();
  for (const profile of new Set(claudeRoots.filter((root) => basename(root) !== "local-agent-mode-sessions").map(dirname))) {
    historyByProfile.set(profile, await history(join(profile, "history.jsonl"), inventory));
    await skills(join(profile, "skills"), "claude", null, inventory, seen);
  }
  for (const profile of new Set(codexRoots.map(dirname))) await skills(join(profile, "skills"), "codex", null, inventory, seen);
  if (sharedSkills) await skills(sharedSkills, "codex", null, inventory, seen);
  dedupeSkills(inventory);
  return { inventory, historyByProfile };
}

export async function addRepositorySkills(inventory: WorkflowInventory, repositories: Array<{ id: string; root_path: string }>): Promise<void> {
  const seen = new Set<string>();
  for (const repository of repositories) {
    if (!repository.root_path) continue;
    await skills(join(repository.root_path, ".claude", "skills"), "claude", repository.id, inventory, seen);
    await skills(join(repository.root_path, ".codex", "skills"), "codex", repository.id, inventory, seen);
    await skills(join(repository.root_path, ".agents", "skills"), "codex", repository.id, inventory, seen);
  }
  dedupeSkills(inventory);
}

function dedupeSkills(inventory: WorkflowInventory): void {
  const unique = new Map<string, WorkflowSkill>();
  for (const skill of inventory.skills) unique.set(JSON.stringify([skill.provider, skill.repositoryId, skill.name]), skill);
  inventory.skills = [...unique.values()].sort((a, b) => a.name.localeCompare(b.name) || a.provider.localeCompare(b.provider));
}

export function historyForTranscript(path: string, sources?: WorkflowSources): WorkflowHistory | undefined {
  if (!sources) return undefined;
  // The transcript may sit several dated/project directories below its profile.
  const profile = [...sources.historyByProfile.keys()].filter((profile) => path.startsWith(`${profile}/`)).sort((a, b) => b.length - a.length)[0];
  return profile ? sources.historyByProfile.get(profile) : undefined;
}
