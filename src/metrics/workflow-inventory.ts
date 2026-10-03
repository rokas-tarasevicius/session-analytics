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
  projectCommands: Map<string, Promise<ReadonlySet<string>>>;
}
const emptyInventory = (): WorkflowInventory => ({ skills: [], directoriesRead: 0, directoriesUnavailable: 0, historyFilesRead: 0, historyFilesUnavailable: 0, malformedHistoryRecords: 0 });
// Deliberately conservative: unknown/new commands contribute only a counter.
const BUILTIN_COMMANDS: ReadonlySet<string> = new Set(["clear", "compact", "config", "context", "cost", "doctor", "help", "init", "login", "logout", "mcp", "memory", "model", "permissions", "plan", "resume", "review", "status"].map((name) => `/${name}`));

/** Internal candidate only: syntax cannot distinguish a command from a path. */
function commandCandidate(display: unknown): string | null {
  if (typeof display !== "string" || display.length === 0 || display[0] !== "/") return null;
  const token = display.match(/^\/([^\s]+)(?:\s|$)/)?.[1];
  const name = workflowName(token);
  return name ? `/${name}` : null;
}

/** A name may leave the parser only with independent registry evidence. */
export function slashCommand(display: unknown, registry: ReadonlySet<string> = BUILTIN_COMMANDS): string | null {
  const candidate = commandCandidate(display);
  return candidate && registry.has(candidate) ? candidate : null;
}

async function history(path: string, inventory: WorkflowInventory, commandNames: ReadonlySet<string>): Promise<WorkflowHistory> {
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
      if (typeof row.display !== "string" || !row.display.startsWith("/")) continue;
      const name = commandCandidate(row.display), time = workflowTimestamp(row.timestamp);
      if (time === null || typeof row.sessionId !== "string" || row.sessionId.length > 256) continue;
      const key = JSON.stringify([row.sessionId, time, name]);
      if (seen.has(key)) continue;
      seen.add(key);
      const events = commands.get(row.sessionId) ?? [];
      events.push({ name, at: new Date(time).toISOString() }); commands.set(row.sessionId, events);
    }
    inventory.historyFilesRead += 1;
    return { commands, available: true, commandNames };
  } catch {
    inventory.historyFilesUnavailable += 1;
    return { commands: new Map(), available: false, commandNames };
  } finally { lines.close(); input.destroy(); }
}

async function commandFiles(path: string, names: Set<string>, prefix = "", depth = 0): Promise<void> {
  if (depth > 8) return;
  try {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory() && workflowName(entry.name)) {
        await commandFiles(join(path, entry.name), names, `${prefix}${entry.name}:`, depth + 1);
      } else if (entry.name.endsWith(".md") && (entry.isFile() || entry.isSymbolicLink())) {
        const name = workflowName(`${prefix}${entry.name.slice(0, -3)}`);
        if (name && (await stat(join(path, entry.name))).isFile()) names.add(`/${name}`);
      }
    }
  } catch { /* Missing registries cannot establish command identity. */ }
}

async function projectCommandNames(root: string): Promise<ReadonlySet<string>> {
  const inventory = emptyInventory(), names = new Set<string>();
  await skills(join(root, ".claude", "skills"), "claude", null, inventory, new Set());
  for (const skill of inventory.skills) names.add(`/${skill.name}`);
  await commandFiles(join(root, ".claude", "commands"), names);
  return names;
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
    const start = inventory.skills.length;
    await skills(join(profile, "skills"), "claude", null, inventory, seen);
    const names = new Set(BUILTIN_COMMANDS);
    for (const skill of inventory.skills.slice(start)) names.add(`/${skill.name}`);
    await commandFiles(join(profile, "commands"), names);
    historyByProfile.set(profile, await history(join(profile, "history.jsonl"), inventory, names));
  }
  for (const profile of new Set(codexRoots.map(dirname))) await skills(join(profile, "skills"), "codex", null, inventory, seen);
  if (sharedSkills) await skills(sharedSkills, "codex", null, inventory, seen);
  dedupeSkills(inventory);
  return { inventory, historyByProfile, projectCommands: new Map() };
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

export async function historyForTranscript(path: string, sources?: WorkflowSources, repositoryRoot?: string): Promise<WorkflowHistory | undefined> {
  if (!sources) return undefined;
  // The transcript may sit several dated/project directories below its profile.
  const profile = [...sources.historyByProfile.keys()].filter((profile) => path.startsWith(`${profile}/`)).sort((a, b) => b.length - a.length)[0];
  const history = profile ? sources.historyByProfile.get(profile) : undefined;
  if (!history || !repositoryRoot) return history;
  let names = sources.projectCommands.get(repositoryRoot);
  if (!names) { names = projectCommandNames(repositoryRoot); sources.projectCommands.set(repositoryRoot, names); }
  return { ...history, commandNames: new Set([...history.commandNames, ...await names]) };
}
