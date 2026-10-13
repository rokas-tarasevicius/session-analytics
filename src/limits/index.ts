import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { discoverProviderRoots } from "../analyzer.ts";
import { dataDirectory } from "../store/database.ts";
import type { AnalyzeOptions } from "../types.ts";
import { claudeSummary, codexSummary, compactObservations, drainInbox, emptyLedger, fromRow, readLedger, resetCreditHistory, restoreInbox, retentionSeconds, toRow, writeLedger } from "./ledger.ts";
import { readCodexAccount } from "./codex-account.ts";
import { claudePlanFrom, harvestClaudeEventLogs, harvestCodex } from "./sources.ts";
import type { CodexAccountState, CodexAccountSummary, LimitObservation, LimitSource, LimitSourceHealth, LimitsSnapshot } from "./types.ts";

export type LimitsOptions = Pick<AnalyzeOptions, "dataDir" | "noIndex" | "codexRoot" | "codexArchiveRoot" | "claudeRoot" | "offline"> & {
  /** Read banked reset credits through the local Codex app-server (Codex contacts OpenAI). On unless `false`. */
  codexAccount?: boolean;
};

/** First harvest on a machine: Codex keeps weeks of sessions; host event logs usually hold about a day. */
const initialLookbackSeconds = 45 * 86_400;
/** Re-read files touched shortly before the previous harvest, in case a write landed during it. */
const harvestOverlapSeconds = 15 * 60;

/** Host applications that log Claude Agent SDK events. T3 Code keeps them under `~/.t3/userdata/logs/provider`. */
export function claudeEventLogRoots(environment: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const override = environment["SESSION_ANALYTICS_CLAUDE_EVENT_LOGS"];
  if (override) return override.split(delimiter).filter(Boolean).map((path) => resolve(path));
  return [join(home, ".t3", "userdata", "logs", "provider")];
}

function credentialPaths(environment: NodeJS.ProcessEnv, home: string): string[] {
  const configured = environment["CLAUDE_CONFIG_DIR"];
  return [...(configured ? [join(resolve(configured), ".credentials.json")] : []), join(home, ".claude", ".credentials.json")];
}

let ledgerCache: { directory: string; observations: LimitObservation[] } | null = null;
// `--no-index` keeps account state for the life of the process only.
let processAccounts: LimitsSnapshot["accounts"] = { codex: null, claude: null };
let processHistory: LimitsSnapshot["resetCreditHistory"] = [];
let lastProcessAccountRead: number | null = null;
/** Banked reset credits change rarely; one account read per ten minutes is plenty. */
const accountReadInterval = 10 * 60;

/**
 * Harvest provider-reported limit meters and fold them into the private ledger. Sources are read-only; the only write
 * is the ledger in the private data directory, skipped entirely with `--no-index`.
 */
export async function collectLimits(options: LimitsOptions = {}, environment: NodeJS.ProcessEnv = process.env, now = Date.now() / 1000): Promise<LimitsSnapshot> {
  const home = environment["HOME"] || homedir();
  const persist = options.noIndex !== true && environment["SESSION_ANALYTICS_NO_INDEX"] !== "1";
  const directory = dataDirectory(options, environment);
  let ledger = emptyLedger();
  if (persist) { try { ledger = readLedger(directory); } catch { ledger = emptyLedger(); } }
  const since = ledger.harvestedThrough ? ledger.harvestedThrough - harvestOverlapSeconds : now - initialLookbackSeconds;

  const codexRoots = options.codexRoot || options.codexArchiveRoot
    ? [options.codexRoot, options.codexArchiveRoot].filter((root): root is string => Boolean(root))
    : (await discoverProviderRoots({ home, codexHome: environment["CODEX_HOME"], claudeConfigDirectory: environment["CLAUDE_CONFIG_DIR"] })).codex;
  // An explicit Claude root replaces discovery, as in analysis: synthetic or narrowed runs never read this machine's Claude state.
  const claudeDiscovery = !options.claudeRoot;
  const eventLogs = claudeDiscovery || environment["SESSION_ANALYTICS_CLAUDE_EVENT_LOGS"] ? claudeEventLogRoots(environment, home) : [];
  const [codex, claude, claudePlan] = await Promise.all([
    harvestCodex(codexRoots, since),
    harvestClaudeEventLogs(eventLogs, since),
    claudeDiscovery ? claudePlanFrom(credentialPaths(environment, home)) : Promise.resolve(null),
  ]);
  const inbox = persist ? (() => { try { return drainInbox(directory); } catch { return []; } })() : [];

  // Banked reset credits are only known to OpenAI. Codex's own app-server reads them (it contacts OpenAI with Codex's
  // login). On by default; off with --no-codex-account or --offline, and never for explicit or synthetic Codex roots.
  const accountOptIn = options.codexAccount !== false && environment["SESSION_ANALYTICS_CODEX_ACCOUNT"] !== "0" &&
    options.offline !== true && environment["SESSION_ANALYTICS_OFFLINE"] !== "1" && !options.codexRoot && !options.codexArchiveRoot;
  const lastAccountRead = persist ? ledger.codexAccountReadAt ?? null : lastProcessAccountRead;
  let account: CodexAccountState | null = null, accountStatus: LimitsSnapshot["codexAccount"] = accountOptIn ? "unavailable" : "off";
  if (accountOptIn && (lastAccountRead === null || now - lastAccountRead >= accountReadInterval)) {
    account = await readCodexAccount(environment, now);
    lastProcessAccountRead = Math.floor(now);
  }
  const previousCodex = persist ? ledger.accounts?.codex ?? null : processAccounts.codex;
  if (accountOptIn && (account || (previousCodex?.resetCredits && lastAccountRead !== null && now - lastAccountRead < 2 * accountReadInterval))) accountStatus = "ok";

  // Without the ledger, an in-process cache keeps what earlier harvests of this process already read.
  const prior = persist ? ledger.rows.map(fromRow).filter((row): row is LimitObservation => row !== null)
    : ledgerCache?.directory === directory ? ledgerCache.observations : [];
  const observations = compactObservations([...prior, ...codex.observations, ...claude.observations, ...inbox, ...(account?.observations ?? [])], now);
  ledgerCache = { directory, observations };

  let codexAccount: CodexAccountSummary | null = account
    ? { observedAt: account.observedAt, credits: account.credits, ordinaryUsageAllowed: account.ordinaryUsageAllowed, resetCredits: account.resetCredits }
    : previousCodex;
  if (codex.codexCredits && codex.codexCredits.credits && codex.codexCredits.observedAt > (codexAccount?.observedAt ?? 0)) {
    codexAccount = { observedAt: codex.codexCredits.observedAt, credits: codex.codexCredits.credits, ordinaryUsageAllowed: codexAccount?.ordinaryUsageAllowed ?? null, resetCredits: codexAccount?.resetCredits ?? null };
  }
  const previousClaude = persist ? ledger.accounts?.claude ?? null : processAccounts.claude;
  const claudeAccount = claude.claudeAccount && claude.claudeAccount.observedAt >= (previousClaude?.observedAt ?? 0) ? claude.claudeAccount : previousClaude;
  const accounts = { codex: codexSummary(codexAccount), claude: claudeSummary(claudeAccount) };
  processAccounts = accounts;

  const history = persist ? [...(ledger.resetCreditHistory ?? [])] : [...processHistory];
  if (account?.resetCredits) {
    const last = history.findLast((row) => row[0] === "codex");
    if (!last || last[2] !== account.resetCredits.available) history.push(["codex", account.observedAt, account.resetCredits.available]);
  }
  const resetCredits = resetCreditHistory(history);
  processHistory = resetCredits;

  const plans = { claude: claudePlan ?? ledger.plans.claude, codex: account?.plan ?? codex.codexPlan ?? ledger.plans.codex };
  let persisted = false;
  if (persist) {
    try {
      writeLedger(directory, {
        version: 1, harvestedThrough: Math.floor(now), plans, rows: observations.map(toRow), accounts, resetCreditHistory: resetCredits,
        codexAccountReadAt: account || lastProcessAccountRead === Math.floor(now) ? Math.floor(now) : ledger.codexAccountReadAt ?? null,
      });
      persisted = true;
    } catch { restoreInbox(directory, inbox); }
  }

  const read: Record<LimitSource, number> = {
    "codex-session": codex.observations.length,
    "codex-account": account?.observations.length ?? 0,
    "claude-sdk-log": claude.observations.length,
    "claude-statusline": inbox.length,
  };
  const available: Record<LimitSource, boolean> = { "codex-session": codex.available, "codex-account": accountOptIn, "claude-sdk-log": claude.available, "claude-statusline": persist };
  const sources: LimitSourceHealth[] = (Object.keys(read) as LimitSource[]).map((source) => {
    const latest = observations.reduce<number | null>((value, row) => row.source === source ? Math.max(value ?? 0, row.observedAt) : value, null);
    return { source, status: latest !== null || read[source] > 0 ? "ok" : available[source] ? "empty" : "unavailable", read: read[source], latest };
  });
  return {
    schemaVersion: 1, generatedAt: new Date(now * 1000).toISOString(), dataSource: "live", persisted, plans, sources,
    observations: observations.filter((row) => row.observedAt >= now - retentionSeconds),
    accounts, resetCreditHistory: resetCredits, codexAccount: accountStatus,
  };
}

export function emptyLimitsSnapshot(dataSource: "live" | "snapshot", now = Date.now() / 1000): LimitsSnapshot {
  return {
    schemaVersion: 1, generatedAt: new Date(now * 1000).toISOString(), dataSource, persisted: false, plans: { claude: null, codex: null }, sources: [], observations: [],
    accounts: { codex: null, claude: null }, resetCreditHistory: [], codexAccount: "off",
  };
}
