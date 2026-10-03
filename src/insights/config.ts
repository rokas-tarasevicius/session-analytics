import { loadPricingCatalog } from "../pricing/catalog.ts";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { discoverProviderRoots } from "../analyzer.ts";
import type { AnalyzeOptions } from "../types.ts";
import { ruleIds } from "./types.ts";
import type { ExtensionInventory, InsightContext, InsightThresholds } from "./types.ts";
import { defaultNextTierModels } from "./pricing-policy.ts";

export const defaultThresholds: Readonly<InsightThresholds> = Object.freeze({
  minRepoSessions: 5, minModelCalls: 10, minInputTokens: 100_000,
  outlierMultiplier: 3, minOutlierUsd: 5, minDifferenceUsd: 1,
  cacheReadShare: 0.3, cacheWriteShare: 0.3, compactionsPer100Calls: 5, minCompactions: 3,
  subagentShare: 0.65, subagentDelta: 0.3, longContextInputTokens: 200_000, longContextShare: 0.3,
  extensionMinSessions: 10, extensionMinToolCalls: 50, idleGapMinEvents: 3,
  timeMinSessions: 20, timeBucketShare: 0.45, utcOffsetMinutes: 0,
});

const shares = new Set(["cacheReadShare", "cacheWriteShare", "subagentShare", "subagentDelta", "longContextShare", "timeBucketShare"]);
const integers = new Set(["minRepoSessions", "minModelCalls", "minInputTokens", "minCompactions", "longContextInputTokens", "extensionMinSessions", "extensionMinToolCalls", "idleGapMinEvents", "timeMinSessions", "utcOffsetMinutes"]);
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
export const boundedName = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const names = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter(boundedName))].sort().slice(0, 200) : [];
const invalid = (): never => { throw new Error("The insights configuration is invalid or unavailable."); };

export function parseInsightConfig(raw: unknown): Pick<InsightContext, "thresholds" | "disabledRules" | "comparisonModels" | "nextTierModels"> {
  const config = record(raw);
  if (!config || Object.keys(config).some((key) => !["thresholds", "disabledRules", "comparisonModels", "nextTierModels", "inventory"].includes(key))) return invalid();
  const thresholds = { ...defaultThresholds };
  if (config["thresholds"] !== undefined) {
    const overrides = record(config["thresholds"]);
    if (!overrides) return invalid();
    for (const [key, value] of Object.entries(overrides)) {
      if (!Object.hasOwn(thresholds, key) || typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1_000_000_000) return invalid();
      if (key === "utcOffsetMinutes" ? Math.abs(value) > 840 : value < 0) return invalid();
      if (shares.has(key) && value > 1) return invalid();
      if (integers.has(key) && !Number.isInteger(value)) return invalid();
      if ((integers.has(key) && key !== "utcOffsetMinutes" && value < 1) || (key === "outlierMultiplier" && value <= 1)) return invalid();
      thresholds[key as keyof InsightThresholds] = value;
    }
  }
  const disabled = config["disabledRules"] ?? [];
  if (!Array.isArray(disabled) || disabled.some((id) => !ruleIds.includes(id))) return invalid();
  const comparison = record(config["comparisonModels"] ?? {});
  if (!comparison || Object.entries(comparison).some(([provider, name]) => !["claude", "codex"].includes(provider) || !boundedName(name))) return invalid();
  const nextTierModels = structuredClone(defaultNextTierModels);
  const mappings = record(config["nextTierModels"] ?? {});
  if (!mappings || Object.keys(mappings).some((provider) => !["claude", "codex"].includes(provider))) return invalid();
  for (const provider of ["claude", "codex"] as const) {
    const overrides = record(mappings[provider] ?? {});
    if (!overrides || Object.keys(overrides).length > 200 || Object.entries(overrides).some(([source, target]) => !boundedName(source) || (target !== null && (!boundedName(target) || source === target)))) return invalid();
    nextTierModels[provider] = { ...nextTierModels[provider], ...overrides as Record<string, string | null> };
  }
  return {
    thresholds, disabledRules: [...new Set(disabled)], nextTierModels,
    comparisonModels: { ...(comparison["claude"] ? { claude: comparison["claude"] as string } : {}), ...(comparison["codex"] ? { codex: comparison["codex"] as string } : {}) },
  };
}

async function smallFile(path: string): Promise<string> {
  if ((await stat(path)).size > 2_000_000) throw new Error("Configuration exceeds the read limit.");
  return await readFile(path, "utf8");
}

/** Project only configured names; never commands, URLs, environment values or settings text. */
export function inventoryFromSettings(raw: unknown): { skills: string[]; mcpServers: string[] } {
  const settings = record(raw) ?? {};
  const mcp = record(settings["mcpServers"]) ?? {};
  const skills = record(settings["skills"]) ?? {};
  return {
    skills: names(Object.keys(skills).filter((key) => skills[key] !== false)),
    mcpServers: names(Object.keys(mcp).filter((key) => record(mcp[key])?.["disabled"] !== true && record(mcp[key])?.["enabled"] !== false)),
  };
}

/** Deliberately narrow TOML recognition: server table names only, no value interpolation. */
export function codexServerNames(text: string): string[] {
  const result = new Map<string, boolean>();
  let current: string | null = null, quote: string | null = null;
  for (const line of text.split("\n")) {
    // A table-looking line inside a multiline command/string is content, not an inventory name.
    if (!quote) {
      const match = line.match(/^\s*\[mcp_servers\.(?:"([A-Za-z0-9._:-]+)"|'([A-Za-z0-9._:-]+)'|([A-Za-z0-9_-]+))\]\s*(?:#.*)?$/);
      if (/^\s*\[/.test(line)) current = match ? match[1] ?? match[2] ?? match[3]! : null;
      if (current && match) result.set(current, true);
      if (current && /^\s*enabled\s*=\s*false\s*(?:#.*)?$/.test(line)) result.set(current, false);
    }
    for (let index = 0; index < line.length; index++) {
      const char = line[index]!;
      if (quote) {
        if (quote.startsWith('"') && char === "\\") { index++; continue; }
        if (line.startsWith(quote, index)) { index += quote.length - 1; quote = null; }
      } else {
        if (char === "#") break;
        if (char === '"' || char === "'") { quote = line.startsWith(char.repeat(3), index) ? char.repeat(3) : char; index += quote.length - 1; }
      }
    }
    // Only TOML multiline strings continue to the next line.
    if (quote?.length === 1) quote = null;
  }
  return names([...result].filter(([, enabled]) => enabled).map(([name]) => name));
}

async function discoverInventory(options: AnalyzeOptions): Promise<{ inventory: ExtensionInventory[]; warnings: string[] }> {
  const home = homedir();
  const roots = await discoverProviderRoots({ home, claudeConfigDirectory: process.env["CLAUDE_CONFIG_DIR"], codexHome: process.env["CODEX_HOME"] });
  const claudeRoots = options.claudeRoot ? [options.claudeRoot] : roots.claude;
  const codexRoots = options.codexRoot || options.codexArchiveRoot ? [options.codexRoot, options.codexArchiveRoot].filter((p): p is string => Boolean(p)) : roots.codex;
  const inventory: ExtensionInventory[] = [];
  let unreadable = 0;
  for (const provider of ["claude", "codex"] as const) {
    const skills = new Set<string>(), servers = new Set<string>();
    const profiles = new Set((provider === "claude" ? claudeRoots : codexRoots).filter((root) => provider === "claude" ? basename(root) === "projects" : ["sessions", "archived_sessions"].includes(basename(root))).map(dirname));
    const jsonPaths = provider === "claude" && !options.claudeRoot ? [join(home, ".claude.json")] : [];
    for (const profile of profiles) {
      if (provider === "claude") jsonPaths.push(join(profile, "settings.json"), join(profile, ".mcp.json"));
      else {
        try { for (const name of codexServerNames(await smallFile(join(profile, "config.toml")))) servers.add(name); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") unreadable++; }
      }
      try {
        for (const entry of await readdir(join(profile, "skills"), { withFileTypes: true })) {
          if (!boundedName(entry.name) || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
          try { if ((await stat(join(profile, "skills", entry.name, "SKILL.md"))).isFile()) skills.add(entry.name); } catch { /* Not an installed skill. */ }
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") unreadable++; }
    }
    for (const path of jsonPaths) {
      try {
        const item = inventoryFromSettings(JSON.parse(await smallFile(path)));
        for (const name of item.skills) skills.add(name);
        for (const name of item.mcpServers) servers.add(name);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") unreadable++; }
    }
    inventory.push({ provider, skills: names([...skills]), mcpServers: names([...servers]) });
  }
  return { inventory, warnings: unreadable ? ["Some extension settings could not be read; inventory coverage is partial."] : [] };
}

export async function loadInsightContext(options: AnalyzeOptions): Promise<InsightContext> {
  let raw: Record<string, unknown> = {};
  if (options.insightsConfigPath) {
    try { raw = JSON.parse(await smallFile(options.insightsConfigPath)) as Record<string, unknown>; } catch { return invalid(); }
  }
  const config = parseInsightConfig(raw);
  const rateCard = await loadPricingCatalog(options);
  for (const provider of ["claude", "codex"] as const) {
    const model = config.comparisonModels[provider];
    if (model && (!Object.hasOwn(rateCard.models, model) || rateCard.models[model]?.provider !== provider)) return invalid();
    const explicit = record(record(raw["nextTierModels"])?.[provider]) ?? {};
    for (const [source, target] of Object.entries(config.nextTierModels[provider] ?? {})) {
      const sourceRate = Object.hasOwn(rateCard.models, source) ? rateCard.models[source] : undefined;
      const targetRate = target && Object.hasOwn(rateCard.models, target) ? rateCard.models[target] : undefined;
      if (sourceRate?.provider !== provider || (target !== null && (!targetRate || targetRate.provider !== provider || targetRate.inputPerMillion <= 0 || targetRate.outputPerMillion <= 0))) {
        if (Object.hasOwn(explicit, source)) return invalid();
        delete config.nextTierModels[provider]![source]; // A custom card may omit default tiers.
      }
    }
  }
  let discovered: { inventory: ExtensionInventory[]; warnings: string[] };
  if (raw["inventory"] !== undefined) {
    const configured = record(raw["inventory"]);
    if (!configured || Object.keys(configured).some((key) => !["claude", "codex"].includes(key))) return invalid();
    discovered = { inventory: [], warnings: [] };
    for (const provider of ["claude", "codex"] as const) {
      const item = record(configured[provider] ?? {});
      if (!item || Object.keys(item).some((key) => !["skills", "mcpServers"].includes(key))) return invalid();
      for (const key of ["skills", "mcpServers"]) if (item[key] !== undefined && (!Array.isArray(item[key]) || (item[key] as unknown[]).some((name) => !boundedName(name)) || (item[key] as unknown[]).length > 200)) return invalid();
      discovered.inventory.push({ provider, skills: names(item["skills"]), mcpServers: names(item["mcpServers"]) });
    }
  } else discovered = await discoverInventory(options);
  return { ...config, ...discovered, rateCard };
}
