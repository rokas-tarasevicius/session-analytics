import { createHash } from "node:crypto";
import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

import { profileKeyFor } from "../metrics/history-coverage.ts";
import {
  codexPlans,
  type ClaudePlan, type CodexPlan, type LimitAccount, type LimitProvider, type PlanEvidence, type PlanSource,
} from "./types.ts";

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const digest = (value: string, length = 16): string => createHash("sha256").update(value).digest("hex").slice(0, length);
/** Provider enums are kept only in this shape; anything else (a name, an email, a path) becomes null. */
export const enumValue = (value: unknown): string | null => typeof value === "string" && /^[a-z0-9_]{1,48}$/.test(value) ? value : null;
const opaqueId = (value: unknown): string | null => typeof value === "string" && value.length > 0 && value.length <= 128 ? value : null;

/** Claude accounts hash the OAuth organization and account IDs, so every profile logged into one account shares a key. */
export const claudeAccountKey = (organization: string, account: string): string =>
  `claude-${digest(`session-analytics/limits/claude-account/v1\0${organization}\0${account}`)}`;
export const codexAccountKey = (account: string): string => `codex-${digest(`session-analytics/limits/codex-account/v1\0${account}`)}`;
/** Unattributed Claude readings are grouped by the minute of the week at which their weekly limit resets. */
export const weeklyPhaseKey = (weeklyResetsAt: number): string => `claude-w-${Math.round(weeklyResetsAt / 60) % 10_080}`;
export const weeklyPhase = (key: string): number | null => key.startsWith("claude-w-") ? Number(key.slice(9)) : null;
/** The first weekly reset at `phase` (minute of the week) after `after`, Unix seconds. */
export const nextWeeklyReset = (phase: number, after: number): number => phase * 60 + (Math.floor((after - phase * 60) / 604_800) + 1) * 604_800;

const accountPattern = /^(?:claude|codex)-(?:p-)?[0-9a-f]{16}$|^claude-w-\d{1,5}$/;
export const validAccount = (provider: LimitProvider, key: unknown): key is string =>
  key === "" || (typeof key === "string" && accountPattern.test(key) && key.startsWith(`${provider}-`));
export function accountAttribution(key: string): LimitAccount["attribution"] {
  return key === "" ? "unattributed" : key.includes("-w-") ? "weekly-phase" : key.includes("-p-") ? "profile" : "account";
}
/** Account and profile keys are real accounts; weekly-phase and unattributed keys are not. */
export const identified = (key: string): boolean => key !== "" && !key.includes("-w-");

export interface Profile {
  provider: LimitProvider;
  directory: string;
  canonical: string;
  /** Claude: `session.historyProfile.profileKey`. Codex: the same hash over the `CODEX_HOME` directory. */
  profileKey: string;
  /** Account key used when the profile's own account cannot be read. */
  fallbackKey: string;
  name: string;
  isDefault: boolean;
}

async function directoryExists(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path); } catch { return resolve(path); }
}

/** A Claude profile or Codex home directory. Names are local labels: `default`, or the directory name without its provider prefix. */
export async function profileFor(provider: LimitProvider, directory: string, home: string): Promise<Profile> {
  const canonical = await canonicalPath(directory);
  const defaultDirectory = join(home, provider === "claude" ? ".claude" : ".codex");
  const isDefault = resolve(directory) === defaultDirectory || canonical === await canonicalPath(defaultDirectory);
  const stripped = basename(directory).replace(/^\.?(?:claude|codex)-/, "").replace(/^\./, "");
  return {
    provider, directory: resolve(directory), canonical, isDefault,
    profileKey: provider === "claude" ? profileKeyFor(canonical) : `profile-${digest(`codex:directory:${canonical}`, 20)}`,
    fallbackKey: `${provider}-p-${digest(`session-analytics/limits/${provider}-profile/v1\0${canonical}`)}`,
    name: isDefault ? "default" : /^[A-Za-z0-9._-]{1,40}$/.test(stripped) ? stripped : "profile",
  };
}

/** Profiles behind discovered transcript roots (`<profile>/projects`, `<home>/sessions`), one per real directory. */
export async function profilesFromRoots(provider: LimitProvider, roots: string[], home: string): Promise<Profile[]> {
  const stores = provider === "claude" ? ["projects"] : ["sessions", "archived_sessions"];
  const profiles = new Map<string, Profile>();
  for (const root of roots) {
    if (!stores.includes(basename(root)) || !await directoryExists(root)) continue;
    const profile = await profileFor(provider, dirname(root), home);
    if (!profiles.has(profile.canonical)) profiles.set(profile.canonical, profile);
  }
  return [...profiles.values()];
}

async function readBounded(path: string, limit: number): Promise<unknown> {
  const info = await stat(path);
  if (!info.isFile() || info.size > limit) return null;
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

/** Plan from Claude's organization type and rate-limit tier. The type decides: a Team seat can carry a Max-like user tier. */
export function claudePlanOf(type: string | null, tier: string | null): ClaudePlan | null {
  const kind = type?.replace(/^claude_/, "") ?? null;
  if (kind === "team" || kind === "enterprise" || kind === "pro") return kind;
  if (kind !== null && kind !== "max") return null;
  return /max_20x/.test(tier ?? "") ? "max-20x" : /max_5x/.test(tier ?? "") || kind === "max" ? "max-5x" : null;
}

export interface ClaudeProfileAccount {
  /** Hashed account key, or null when the profile's account record could not be read. */
  key: string | null;
  plan: ClaudePlan | null;
  planSource: PlanSource | null;
  planEvidence: PlanEvidence | null;
  extraUsageEnabled: boolean | null;
}

/**
 * The account a Claude profile is logged into, from `oauthAccount` in its `.claude.json` (`~/.claude.json` for the default
 * profile). The organization and account IDs are hashed here and dropped; only allowlisted plan enums and the extra-usage
 * flag leave this function, and emails, names and organization names are never read into the result. Without that record,
 * the plan falls back to `.credentials.json` (`subscriptionType`, `rateLimitTier`); tokens are never read into results.
 */
export async function readClaudeProfile(profile: Pick<Profile, "directory" | "isDefault">, home: string): Promise<ClaudeProfileAccount> {
  const configs = profile.isDefault ? [join(home, ".claude.json"), join(profile.directory, ".claude.json")] : [join(profile.directory, ".claude.json")];
  let found: ClaudeProfileAccount | null = null;
  for (const path of configs) {
    let oauth: Record<string, unknown> | null;
    // Claude Code rewrites this file while running; a torn read is skipped and the ledger keeps the last known account.
    try { oauth = record(record(await readBounded(path, 8 * 1024 * 1024))?.["oauthAccount"]); } catch { continue; }
    if (!oauth) continue;
    const account = opaqueId(oauth["accountUuid"]);
    const evidence: PlanEvidence = {
      organizationType: enumValue(oauth["organizationType"]), organizationRateLimitTier: enumValue(oauth["organizationRateLimitTier"]),
      userRateLimitTier: enumValue(oauth["userRateLimitTier"]), seatTier: enumValue(oauth["seatTier"]), billingType: enumValue(oauth["billingType"]), planType: null,
    };
    const plan = claudePlanOf(evidence.organizationType, evidence.organizationRateLimitTier ?? evidence.userRateLimitTier);
    found = {
      key: account ? claudeAccountKey(opaqueId(oauth["organizationUuid"]) ?? "", account) : null,
      plan, planSource: plan ? "claude-config" : null, planEvidence: evidence,
      extraUsageEnabled: typeof oauth["hasExtraUsageEnabled"] === "boolean" ? oauth["hasExtraUsageEnabled"] : null,
    };
    break;
  }
  if (found?.plan) return found;
  let plan: ClaudePlan | null = null;
  try {
    const oauth = record(record(await readBounded(join(profile.directory, ".credentials.json"), 64 * 1024))?.["claudeAiOauth"]);
    plan = claudePlanOf(enumValue(oauth?.["subscriptionType"]), enumValue(oauth?.["rateLimitTier"]));
  } catch { /* Missing or unreadable records leave the plan to the ledger and the dashboard setting. */ }
  return { key: found?.key ?? null, plan, planSource: plan ? "claude-credentials" : null, planEvidence: found?.planEvidence ?? null, extraUsageEnabled: found?.extraUsageEnabled ?? null };
}

/** Claude session IDs (`<profile>/projects/<project>/<id>.jsonl`), found by listing directories: transcripts are never opened. */
async function sessionIndex(profiles: Profile[]): Promise<Map<string, number>> {
  const index = new Map<string, number>();
  for (const [ordinal, profile] of profiles.entries()) {
    let projects: string[];
    try { projects = (await readdir(join(profile.directory, "projects"), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name); }
    catch { continue; }
    for (const project of projects) {
      let names: string[];
      try { names = await readdir(join(profile.directory, "projects", project)); } catch { continue; }
      for (const name of names) {
        if (!/^[0-9a-f-]{36}\.jsonl$/.test(name)) continue;
        const id = name.slice(0, 36), seen = index.get(id);
        index.set(id, seen === undefined || seen === ordinal ? ordinal : -1);
      }
    }
  }
  return index;
}

export interface ClaudeIdentities {
  profiles: Profile[];
  /** The account key of a profile; `.claude.json` is read at most once per harvest. */
  account(profile: Profile): Promise<string>;
  details(profile: Profile): Promise<ClaudeProfileAccount>;
  bySession(sessionId: string): Promise<Profile | null>;
  byTranscript(path: string): Profile | null;
}

/**
 * Attribution of Claude readings to accounts for one harvest. `known` maps a profile key to the account it had in an earlier
 * harvest, so a profile whose `.claude.json` is briefly unreadable keeps its account instead of becoming a new one.
 */
export function claudeIdentities(profiles: Profile[], home: string, known: (profileKey: string) => string | null = () => null): ClaudeIdentities {
  const details = new Map<string, Promise<ClaudeProfileAccount>>();
  let sessions: Promise<Map<string, number>> | null = null;
  const read = (profile: Profile) => {
    let pending = details.get(profile.canonical);
    if (!pending) { pending = readClaudeProfile(profile, home); details.set(profile.canonical, pending); }
    return pending;
  };
  return {
    profiles,
    details: read,
    async account(profile) { return (await read(profile)).key ?? known(profile.profileKey) ?? profile.fallbackKey; },
    async bySession(sessionId) {
      if (!/^[0-9a-f-]{36}$/.test(sessionId)) return null;
      sessions ??= sessionIndex(profiles);
      const ordinal = (await sessions).get(sessionId);
      return ordinal === undefined || ordinal < 0 ? null : profiles[ordinal] ?? null;
    },
    byTranscript(path) {
      const full = resolve(path);
      return [...profiles].sort((left, right) => right.directory.length - left.directory.length)
        .find((profile) => [profile.directory, profile.canonical].some((directory) => full.startsWith(`${join(directory, "projects")}${sep}`))) ?? null;
    },
  };
}

/** The Codex account that started a rollout (`session_meta.creator_account_id` on its first line), hashed here. */
export async function rolloutAccount(path: string): Promise<string | null> {
  let handle;
  try { handle = await open(path, "r"); } catch { return null; }
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const end = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (end < 0) return null;
    const line = record(JSON.parse(buffer.subarray(0, end).toString("utf8")));
    const id = line?.["type"] === "session_meta" ? opaqueId(record(line["payload"])?.["creator_account_id"]) : null;
    return id ? codexAccountKey(id) : null;
  } catch { return null; } finally { await handle.close(); }
}

const planNames: Record<LimitProvider, Record<string, string>> = {
  claude: { pro: "Claude Pro", "max-5x": "Claude Max 5x", "max-20x": "Claude Max 20x", team: "Claude Team", enterprise: "Claude Enterprise" },
  codex: { free: "ChatGPT Free", go: "ChatGPT Go", plus: "ChatGPT Plus", prolite: "ChatGPT Pro 100", pro: "ChatGPT Pro 200", team: "ChatGPT Business", business: "ChatGPT Business", enterprise: "ChatGPT Enterprise", edu: "ChatGPT Edu" },
};
const providerTitles: Record<LimitProvider, string> = { claude: "Claude", codex: "Codex" };

const weekday = (seconds: number): string => new Date(seconds * 1000).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" });

/** `Claude Max 20x · work`: plan and the account's non-default profile names; never an email, organization or ID. */
export function accountLabel(provider: LimitProvider, key: string, plan: string | null, profileNames: string[], weeklyAnchor: number | null): string {
  if (key === "") return "Unattributed history";
  const phase = weeklyPhase(key);
  if (phase !== null) return `${providerTitles[provider]} · unidentified account (weekly reset ${weekday(nextWeeklyReset(phase, Date.now() / 1000))})`;
  const title = (plan && planNames[provider][plan]) ?? providerTitles[provider];
  const names = profileNames.filter((name) => name !== "default");
  if (names.length) return `${title} · ${names.join(", ")}`;
  if (profileNames.length) return `${title} · default`;
  return weeklyAnchor && provider === "claude" ? `${title} · weekly reset ${weekday(weeklyAnchor)}` : title;
}

export const codexPlan = (value: unknown): CodexPlan | null => typeof value === "string" && (codexPlans as readonly string[]).includes(value) ? value as CodexPlan : null;
