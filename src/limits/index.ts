import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

import { discoverProviderRoots } from "../analyzer.ts";
import { meterLabel } from "../public/subscription-data.js";
import { dataDirectory } from "../store/database.ts";
import type { AnalyzeOptions } from "../types.ts";
import { accountAttribution, accountLabel, claudeIdentities, identified, profileFor, profilesFromRoots, rolloutAccount, weeklyPhaseKey, type Profile } from "./accounts.ts";
import { readCodexAccount } from "./codex-account.ts";
import {
  LEDGER_UNREADABLE, applyAliases, attributeLegacy, claudeSummary, codexSummary, compactObservations, emptyLedger, fromRow, readLedger,
  readLegacyLedger, resetCreditHistory, retentionSeconds, setAsideLedger, toRow, writeLedger, type Ledger, type LedgerAccount,
} from "./ledger.ts";
import { harvestClaudeEventLogs, harvestCodex, type Cursors } from "./sources.ts";
import type {
  ClaudeAccountSummary, CodexAccountState, CodexAccountSummary, LimitAccount, LimitMeterInfo, LimitObservation, LimitProvider, LimitSource,
  LimitSourceHealth, LimitsSnapshot, PlanSource,
} from "./types.ts";

export type LimitsOptions = Pick<AnalyzeOptions, "dataDir" | "noIndex" | "codexRoot" | "codexArchiveRoot" | "claudeRoot" | "offline"> & {
  /** Read banked reset credits through the local Codex app-server (Codex contacts OpenAI). On unless `false`. */
  codexAccount?: boolean;
  /** `false` leaves full Claude readings unsettled (`resolveCaps`), for a reader that merges them with other machines' first. */
  settle?: boolean;
};

/** First harvest on a machine: Codex keeps weeks of sessions, and T3 Code keeps several days of events. */
const initialLookbackSeconds = 45 * 86_400;
/** Re-read files touched shortly before the previous harvest, in case a write landed during it. */
const harvestOverlapSeconds = 15 * 60;
/** Banked reset credits change rarely; one account read per ten minutes is plenty. */
const accountReadInterval = 10 * 60;

/** Host applications that log Claude Agent SDK events. T3 Code keeps them under `~/.t3/userdata/logs/provider`. */
export function claudeEventLogRoots(environment: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const override = environment["SESSION_ANALYTICS_CLAUDE_EVENT_LOGS"];
  if (override) return override.split(delimiter).filter(Boolean).map((path) => resolve(path));
  return [join(home, ".t3", "userdata", "logs", "provider")];
}

// `--no-index`, or a ledger this version cannot read, keeps the ledger in memory for the life of the process.
const processLedgers = new Map<string, Ledger>();
let queue: Promise<unknown> = Promise.resolve();

const later = <T extends { observedAt: number }>(left: T | null | undefined, right: T | null | undefined): T | null =>
  !left ? right ?? null : !right ? left : right.observedAt >= left.observedAt ? right : left;

/**
 * Harvest provider-reported limit meters and fold them into the private ledger, attributed to accounts. Sources are
 * read-only; the only write is the ledger in the private data directory, skipped entirely with `--no-index`. Harvests in
 * one process run one at a time; writes from every process take turns through the ledger's gate.
 */
export function collectLimits(options: LimitsOptions = {}, environment: NodeJS.ProcessEnv = process.env, now?: number): Promise<LimitsSnapshot> {
  const run = queue.then(() => harvest(options, environment, now ?? Date.now() / 1000));
  queue = run.catch(() => undefined);
  return run;
}

async function harvest(options: LimitsOptions, environment: NodeJS.ProcessEnv, now: number): Promise<LimitsSnapshot> {
  const home = environment["HOME"] || homedir();
  const persist = options.noIndex !== true && environment["SESSION_ANALYTICS_NO_INDEX"] !== "1";
  const directory = dataDirectory(options, environment);
  let ledgerStatus: LimitsSnapshot["ledger"] = persist ? "ok" : "off";
  let base = processLedgers.get(directory) ?? emptyLedger();
  if (persist) {
    const read = readLedger(directory, now);
    if (read.status === "corrupt") { try { setAsideLedger(directory, now); base = emptyLedger(); } catch { ledgerStatus = "unreadable"; } }
    else if (read.status === "foreign") ledgerStatus = "unreadable";
    else if (read.ledger) base = read.ledger;
  }
  const writable = persist && ledgerStatus === "ok";
  const since = base.harvestedThrough ? base.harvestedThrough - harvestOverlapSeconds : now - initialLookbackSeconds;
  const cursors: Cursors = new Map(Object.entries(base.cursors));

  const explicitCodex = [options.codexRoot, options.codexArchiveRoot].filter((root): root is string => Boolean(root));
  const discovered = explicitCodex.length && options.claudeRoot ? null
    : await discoverProviderRoots({ home, codexHome: environment["CODEX_HOME"], claudeConfigDirectory: environment["CLAUDE_CONFIG_DIR"] });
  const codexRoots = explicitCodex.length ? explicitCodex : discovered!.codex;
  // An explicit Claude root replaces discovery, as in analysis: synthetic or narrowed runs never read this machine's Claude state.
  const claudeProfiles = await profilesFromRoots("claude", options.claudeRoot ? [options.claudeRoot] : discovered!.claude, home);
  const codexHomes = await profilesFromRoots("codex", codexRoots, home);
  const defaultCodexHome = codexHomes.find((profile) => profile.isDefault) ?? await profileFor("codex", join(home, ".codex"), home);
  const eventLogs = !options.claudeRoot || environment["SESSION_ANALYTICS_CLAUDE_EVENT_LOGS"] ? claudeEventLogRoots(environment, home) : [];
  const [codex, claude] = await Promise.all([
    harvestCodex(codexRoots, since, cursors, now, rolloutAccount),
    harvestClaudeEventLogs(eventLogs, since, cursors, now),
  ]);
  const fresh: LimitObservation[] = [];

  // Claude: a session's transcript names its profile, a profile's `.claude.json` names its account.
  const identities = claudeIdentities(claudeProfiles, home, (profileKey) => base.profiles[profileKey] ?? null);
  const claudeAccounts = new Map<Profile, string>();
  for (const profile of claudeProfiles) claudeAccounts.set(profile, await identities.account(profile));
  const extraUsage = new Map<string, ClaudeAccountSummary>();
  for (const event of claude.events) {
    const profile = event.sessionId ? await identities.bySession(event.sessionId) : null;
    const account = profile ? claudeAccounts.get(profile)! : event.weeklyResetsAt ? weeklyPhaseKey(event.weeklyResetsAt) : "";
    for (const observation of event.observations) fresh.push({ ...observation, account });
    if (event.account && identified(account)) extraUsage.set(account, later(extraUsage.get(account), event.account)!);
  }

  // Codex: a rollout names the account that created it; older rollouts fall back to their CODEX_HOME's only account.
  const homeOfRoot = new Map<string, Profile>();
  for (const root of codexRoots) {
    const canonical = (await profileFor("codex", dirname(root), home)).canonical;
    const profile = codexHomes.find((item) => item.canonical === canonical);
    if (profile) homeOfRoot.set(root, profile);
  }
  // Every account seen in a home, across harvests: one incremental batch can hold only one of a home's two logins.
  const creators = new Map<string, Set<string>>();
  const creatorsOf = (profile: Profile): Set<string> => {
    let seen = creators.get(profile.fallbackKey);
    if (!seen) { seen = new Set(base.creators[profile.fallbackKey] ?? []); creators.set(profile.fallbackKey, seen); }
    return seen;
  };
  for (const file of codex.files) {
    const profile = homeOfRoot.get(file.root);
    if (profile && file.account) creatorsOf(profile).add(file.account);
  }
  const homeAccount = (profile: Profile): string => {
    const seen = creatorsOf(profile);
    return seen.size === 1 ? [...seen][0]! : profile.fallbackKey;
  };
  type CodexPlanReading = { plan: CodexAccountState["plan"]; planType: string | null; at: number; source: PlanSource };
  const codexPlans = new Map<string, CodexPlanReading>();
  const codexAccounts = new Map<string, CodexAccountSummary>();
  const limitNames = { ...base.limitNames };
  // `unknown` (and a missing plan type) is no evidence: Codex writes it in some records of a known plan.
  const notePlan = (account: string, reading: CodexPlanReading) => {
    if ((reading.plan || (reading.planType && reading.planType !== "unknown")) && reading.at >= (codexPlans.get(account)?.at ?? 0)) codexPlans.set(account, reading);
  };
  let sessionReads = 0;
  for (const file of codex.files) {
    const profile = homeOfRoot.get(file.root);
    const account = file.account ?? (profile ? homeAccount(profile) : "");
    for (const record of file.records) {
      sessionReads += record.observations.length;
      for (const observation of record.observations) fresh.push({ ...observation, account });
      const at = record.observations[0]?.observedAt ?? 0;
      notePlan(account, { plan: record.plan, planType: record.planType, at, source: "codex-session" });
      if (record.credits && at > (codexAccounts.get(account)?.observedAt ?? 0)) {
        codexAccounts.set(account, { observedAt: at, credits: record.credits, ordinaryUsageAllowed: null, resetCredits: null });
      }
      if (record.limitName && record.limitId !== "codex") limitNames[record.limitId] = record.limitName;
    }
  }

  // Banked reset credits are only known to OpenAI. Codex's own app-server reads them (it contacts OpenAI with Codex's
  // login), once per CODEX_HOME. On by default; off with --no-codex-account or --offline, and never for explicit roots.
  const accountOptIn = options.codexAccount !== false && environment["SESSION_ANALYTICS_CODEX_ACCOUNT"] !== "0" &&
    options.offline !== true && environment["SESSION_ANALYTICS_OFFLINE"] !== "1" && !explicitCodex.length;
  let codexAccountReadAt = base.codexAccountReadAt;
  const history = [...base.resetCreditHistory];
  let accountReads = 0, answered = false;
  if (accountOptIn && (codexAccountReadAt === null || now - codexAccountReadAt >= accountReadInterval)) {
    const reads = await Promise.all((codexHomes.length ? codexHomes : [null]).map(async (profile) => ({
      profile: profile ?? defaultCodexHome,
      state: await readCodexAccount(profile ? { ...environment, CODEX_HOME: profile.canonical } : environment, now),
    })));
    codexAccountReadAt = Math.floor(now);
    for (const { profile, state } of reads) {
      if (!state) continue;
      answered = true;
      // The login the app-server answers for is one of the home's accounts, like a rollout's creator.
      if (state.account) creatorsOf(profile).add(state.account);
      const account = state.account ?? homeAccount(profile);
      accountReads += state.observations.length;
      for (const observation of state.observations) fresh.push({ ...observation, account });
      notePlan(account, { plan: state.plan, planType: state.planType, at: state.observedAt, source: "codex-account" });
      const previous = codexAccounts.get(account) ?? base.accounts[account]?.codex ?? null;
      codexAccounts.set(account, { observedAt: state.observedAt, credits: state.credits ?? previous?.credits ?? null, ordinaryUsageAllowed: state.ordinaryUsageAllowed, resetCredits: state.resetCredits });
      Object.assign(limitNames, state.limitNames);
      if (state.resetCredits) {
        const last = history.findLast((row) => row[0] === "codex" && row[1] === account);
        if (!last || last[3] !== state.resetCredits.available) history.push(["codex", account, state.observedAt, state.resetCredits.available]);
      }
    }
  }

  // Readings kept under a profile's fallback key join the profile's account once that account is known, here and in
  // every later merge with a ledger another process wrote meanwhile.
  const aliases = { ...base.aliases };
  for (const [profile, account] of claudeAccounts) if (accountAttribution(account) === "account") aliases[profile.fallbackKey] = account;
  for (const profile of codexHomes) {
    const account = homeAccount(profile);
    if (accountAttribution(account) === "account") aliases[profile.fallbackKey] = account;
    else delete aliases[profile.fallbackKey];
  }
  const rekey = (account: string) => aliases[account] ?? account;
  const healed = applyAliases({ ...base, aliases });
  let observations = [...healed.rows.map(fromRow).filter((row): row is LimitObservation => row !== null), ...fresh]
    .map((row) => aliases[row.account] ? { ...row, account: rekey(row.account) } : row);

  const accounts: Record<string, LedgerAccount> = { ...healed.accounts };
  const touch = (key: string, provider: LimitProvider): LedgerAccount => accounts[key] ??= {
    provider, plan: null, planSource: null, planEvidence: null, planObservedAt: null, extraUsage: null, codex: null, profileKeys: [],
  };
  const profiles = { ...base.profiles };
  const seeds = new Map<string, boolean>();
  for (const [profile, key] of claudeAccounts) {
    const detail = await identities.details(profile);
    const account = touch(key, "claude");
    if (!account.profileKeys.includes(profile.profileKey)) account.profileKeys = [...account.profileKeys, profile.profileKey];
    if (detail.key) profiles[profile.profileKey] = key;
    if (detail.plan) Object.assign(account, { plan: detail.plan, planSource: detail.planSource, planEvidence: detail.planEvidence, planObservedAt: Math.floor(now) });
    else if (detail.planEvidence) account.planEvidence = detail.planEvidence;
    if (detail.extraUsageEnabled !== null) seeds.set(key, detail.extraUsageEnabled || seeds.get(key) === true);
  }
  for (const [key, summary] of extraUsage) { const account = touch(key, "claude"); account.extraUsage = later(account.extraUsage, summary); }
  for (const profile of codexHomes) {
    const key = homeAccount(profile);
    if (accountAttribution(key) !== "account") continue;
    profiles[profile.profileKey] = key;
    const account = touch(key, "codex");
    if (!account.profileKeys.includes(profile.profileKey)) account.profileKeys = [...account.profileKeys, profile.profileKey];
  }
  for (const [key, reading] of codexPlans) {
    if (!identified(key)) continue;
    const account = touch(key, "codex");
    if (reading.at < (account.planObservedAt ?? 0)) continue;
    Object.assign(account, { plan: reading.plan, planSource: reading.plan ? reading.source : null, planObservedAt: reading.at,
      planEvidence: { organizationType: null, organizationRateLimitTier: null, userRateLimitTier: null, seatTier: null, billingType: null, planType: reading.planType } });
  }
  for (const [key, summary] of codexAccounts) {
    if (!identified(key)) continue;
    const account = touch(key, "codex");
    const merged = later(account.codex, summary)!;
    account.codex = { ...merged, resetCredits: merged.resetCredits ?? account.codex?.resetCredits ?? null, ordinaryUsageAllowed: merged.ordinaryUsageAllowed ?? account.codex?.ordinaryUsageAllowed ?? null };
  }

  // Version 1 ledgers (`limits.json`) are imported, never written: older binaries may keep appending to them.
  let importedV1Through = base.importedV1Through;
  if (persist) {
    const legacy = readLegacyLedger(directory);
    if (legacy) {
      const pending = legacy.observations.filter((row) => row.observedAt > (importedV1Through ?? 0));
      const codexKeys = [...new Set([...observations.filter((row) => row.provider === "codex").map((row) => row.account),
        ...Object.entries(accounts).filter(([, account]) => account.provider === "codex").map(([key]) => key)].filter(identified))];
      observations = [...observations, ...attributeLegacy(pending, observations, codexKeys)];
      importedV1Through = legacy.observations.reduce((latest, row) => Math.max(latest, row.observedAt), importedV1Through ?? 0) || null;
      if (codexKeys.length === 1) {
        const account = touch(codexKeys[0]!, "codex");
        if (!account.plan && legacy.codexPlan) Object.assign(account, { plan: legacy.codexPlan, planSource: "codex-session" });
        // A newer session-derived summary carries no banked resets; the count version 1 read is kept field by field.
        const [current, merged] = [account.codex, later(account.codex, legacy.codex)];
        if (merged) account.codex = {
          ...merged, resetCredits: merged.resetCredits ?? current?.resetCredits ?? legacy.codex?.resetCredits ?? null,
          ordinaryUsageAllowed: merged.ordinaryUsageAllowed ?? current?.ordinaryUsageAllowed ?? legacy.codex?.ordinaryUsageAllowed ?? null,
        };
        history.push(...legacy.resetCreditHistory.map(([at, available]): [LimitProvider, string, number, number] => ["codex", codexKeys[0]!, at, available]));
      }
    }
  }

  const rows = compactObservations(observations, now);
  const live = new Set(rows.map((row) => row.account));
  for (const key of Object.keys(accounts)) if (!live.has(key) && !Object.values(profiles).includes(key) && ![...claudeAccounts.values()].includes(key)) delete accounts[key];
  const homes = Object.fromEntries([...creators].filter(([, seen]) => seen.size).map(([key, seen]) => [key, [...seen].sort()]));
  const next: Ledger = {
    version: 2, harvestedThrough: Math.floor(now), importedV1Through, cursors: Object.fromEntries(cursors), accounts, profiles, aliases,
    creators: { ...base.creators, ...homes }, limitNames,
    rows: rows.map(toRow), resetCreditHistory: resetCreditHistory(history.map((row) => [row[0], rekey(row[1]), row[2], row[3]])), codexAccountReadAt,
  };
  let ledger = next, persisted = false, inbox = 0;
  if (writable) {
    try { const written = writeLedger(directory, next, now, { inbox: true }); ledger = written.ledger; inbox = written.inbox.length; persisted = true; }
    catch (error) { ledgerStatus = (error as Error).message === LEDGER_UNREADABLE ? "unreadable" : "unwritable"; }
  } else processLedgers.set(directory, next);

  const kept = ledger.rows.map(fromRow).filter((row): row is LimitObservation => row !== null && row.observedAt >= now - retentionSeconds);
  const lastCodexRead = ledger.codexAccountReadAt;
  const codexAccount: LimitsSnapshot["codexAccount"] = !accountOptIn ? "off"
    : answered || (lastCodexRead !== null && now - lastCodexRead < 2 * accountReadInterval && Object.values(ledger.accounts).some((account) => account.codex?.resetCredits)) ? "ok" : "unavailable";
  const names = new Map<string, string[]>();
  for (const [profile, key] of claudeAccounts) names.set(key, [...(names.get(key) ?? []), profile.name]);
  for (const profile of codexHomes) { const key = homeAccount(profile); if (live.has(key) || ledger.accounts[key]) names.set(key, [...(names.get(key) ?? []), profile.name]); }
  const read: Record<LimitSource, number> = {
    "codex-session": sessionReads, "codex-account": accountReads,
    "claude-sdk-log": claude.events.reduce((total, event) => total + event.observations.length, 0), "claude-statusline": inbox,
  };
  const available: Record<LimitSource, boolean> = { "codex-session": codex.available, "codex-account": accountOptIn, "claude-sdk-log": claude.available, "claude-statusline": persist };
  const summary = snapshotAccounts(kept, ledger, names, seeds, now);
  return {
    schemaVersion: 2, generatedAt: new Date(now * 1000).toISOString(), dataSource: "live", persisted, ledger: ledgerStatus,
    ...summary, sources: sourceHealth(kept, read, available), observations: options.settle === false ? kept : resolveCaps(kept, summary.accounts),
    resetCreditHistory: ledger.resetCreditHistory, codexAccount,
  };
}

/**
 * Claude readings at or past 100% that do not say whether work continued (status-line readings, an event's windows other
 * than the one it reports on) are settled here from the account's extra-usage state: off means the cap was hit, on means
 * work continued on extra usage. With the state unknown, only a reading past 100% counts as extra usage. The ledger keeps
 * them unresolved, so a later, better known state settles them again.
 */
export function resolveCaps(rows: LimitObservation[], accounts: Pick<LimitAccount, "key" | "provider" | "extraUsage">[]): LimitObservation[] {
  const extra = new Map(accounts.filter((account) => account.provider === "claude").map((account) => [account.key, account.extraUsage?.extraUsage ?? "unknown"]));
  return rows.map((row) => {
    if (row.provider !== "claude" || row.usedPercent < 100 || row.status === "rejected" || row.status === "overage" || row.status === "idle") return row;
    const state = extra.get(row.account) ?? "unknown";
    const continued = state === "enabled" || state === "in-use" || (state !== "disabled" && row.usedPercent > 100);
    return { ...row, status: continued ? "overage" : "rejected" };
  });
}

function sourceHealth(rows: LimitObservation[], read: Record<LimitSource, number>, available: Record<LimitSource, boolean>): LimitSourceHealth[] {
  return (Object.keys(read) as LimitSource[]).map((source) => {
    const latest = rows.reduce<number | null>((value, row) => row.source === source ? Math.max(value ?? 0, row.observedAt) : value, null);
    return { source, status: latest !== null || read[source] > 0 ? "ok" : available[source] ? "empty" : "unavailable", read: read[source], latest };
  });
}

/** Scoped Codex limits are named by the provider's limit name; their weekly window never claims to cover all models. */
function meterTitle(meter: string, limitNames: Record<string, string>): string {
  const dot = meter.lastIndexOf(".");
  if (dot < 0) return meterLabel(meter);
  return `${limitNames[meter.slice(0, dot)] ?? "Model-scoped limit"} · ${meterLabel(meter.slice(dot + 1)).replace(" · all models", "")}`;
}

const providerOrder = (provider: LimitProvider): number => provider === "claude" ? 0 : 1;
const attributionOrder: Record<LimitAccount["attribution"], number> = { account: 0, profile: 0, "weekly-phase": 1, unattributed: 2 };

/** Claude first, then accounts before groups of readings without one, the most recently active first. */
export const accountOrder = (left: LimitAccount, right: LimitAccount): number =>
  providerOrder(left.provider) - providerOrder(right.provider) || attributionOrder[left.attribution] - attributionOrder[right.attribution] ||
  (right.lastSeen ?? 0) - (left.lastSeen ?? 0) || left.key.localeCompare(right.key);

/** Each account's latest reading and latest weekly reset, by `provider|account`. */
export function accountActivity(rows: LimitObservation[]): { lastSeen: Map<string, number>; anchors: Map<string, number> } {
  const lastSeen = new Map<string, number>(), anchors = new Map<string, number>();
  for (const row of rows) {
    const id = `${row.provider}|${row.account}`;
    lastSeen.set(id, Math.max(lastSeen.get(id) ?? 0, row.observedAt));
    if (row.meter === "seven_day" && row.status !== "idle") anchors.set(id, Math.max(anchors.get(id) ?? 0, row.resetsAt));
  }
  return { lastSeen, anchors };
}

/** One entry per account and meter. A meter is retired when its account kept reporting other meters for longer than its window. */
export function meterInfos(rows: LimitObservation[], title: (row: LimitObservation) => string): LimitMeterInfo[] {
  const { lastSeen } = accountActivity(rows), meters = new Map<string, LimitMeterInfo>();
  for (const row of rows) {
    const id = `${row.provider}|${row.account}|${row.meter}`, meter = meters.get(id);
    if (!meter) meters.set(id, { provider: row.provider, account: row.account, meter: row.meter, label: title(row), windowMinutes: row.windowMinutes, lastObservedAt: row.observedAt, retired: false });
    else { meter.lastObservedAt = Math.max(meter.lastObservedAt, row.observedAt); meter.windowMinutes ??= row.windowMinutes; }
  }
  for (const meter of meters.values()) {
    const window = meter.windowMinutes ? meter.windowMinutes * 60 : 7 * 86_400;
    meter.retired = (lastSeen.get(`${meter.provider}|${meter.account}`) ?? 0) - meter.lastObservedAt > window;
  }
  return [...meters.values()].sort((left, right) => left.provider.localeCompare(right.provider) || left.account.localeCompare(right.account) || left.meter.localeCompare(right.meter));
}

/** Deprecated `plans`: the plan of each provider's most recently active account, from accounts in `accountOrder`. */
export function activePlans(accounts: LimitAccount[]): LimitsSnapshot["plans"] {
  const active = (provider: LimitProvider) => accounts.find((account) => account.provider === provider && identified(account.key))?.plan ?? null;
  return { claude: active("claude") as LimitsSnapshot["plans"]["claude"], codex: active("codex") as LimitsSnapshot["plans"]["codex"] };
}

function snapshotAccounts(rows: LimitObservation[], ledger: Ledger, names: Map<string, string[]>, seeds: Map<string, boolean>, now: number): Pick<LimitsSnapshot, "accounts" | "meters" | "plans"> {
  const { lastSeen, anchors } = accountActivity(rows);
  const keys = new Map<string, LimitProvider>();
  for (const row of rows) keys.set(`${row.provider}|${row.account}`, row.provider);
  for (const [key, account] of Object.entries(ledger.accounts)) if (names.has(key) && accountAttribution(key) === "account") keys.set(`${account.provider}|${key}`, account.provider);
  const accounts: LimitAccount[] = [...keys].map(([id, provider]) => {
    const key = id.slice(provider.length + 1), record = ledger.accounts[key];
    const profileNames = [...new Set(names.get(key) ?? [])].sort((left, right) => (left === "default" ? -1 : right === "default" ? 1 : left.localeCompare(right)));
    const plan = record?.plan ?? null, weeklyAnchor = anchors.get(id) ?? null;
    const seed = seeds.get(key);
    return {
      key, provider, attribution: accountAttribution(key), label: accountLabel(provider, key, plan, profileNames, weeklyAnchor), profileNames,
      profileKeys: record?.profileKeys ?? [], plan, planSource: record?.planSource ?? null, planEvidence: record?.planEvidence ?? null, planObservedAt: record?.planObservedAt ?? null,
      extraUsage: provider === "claude" ? claudeSummary(record?.extraUsage) ?? (seed === undefined ? null : { observedAt: Math.floor(now), extraUsage: seed ? "enabled" : "disabled", disabledReason: null }) : null,
      codex: provider === "codex" ? codexSummary(record?.codex) : null,
      weeklyAnchor, lastSeen: lastSeen.get(id) ?? null,
    };
  }).sort(accountOrder);
  return { accounts, meters: meterInfos(rows, (row) => meterTitle(row.meter, ledger.limitNames)), plans: activePlans(accounts) };
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/**
 * The account a Claude Code status line reports for: its inherited `CLAUDE_CONFIG_DIR`, else the profile holding its
 * transcript, else the profile holding its session. Unknown profiles fall back to the weekly-phase key.
 */
export async function statuslineAccount(input: unknown, environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  const home = environment["HOME"] || homedir();
  const value = record(input), configured = environment["CLAUDE_CONFIG_DIR"];
  const profiles = await profilesFromRoots("claude", (await discoverProviderRoots({ home, claudeConfigDirectory: configured })).claude, home);
  const identities = claudeIdentities(profiles, home);
  const transcript = typeof value?.["transcript_path"] === "string" ? identities.byTranscript(value["transcript_path"]) : null;
  const profile = configured ? await profileFor("claude", configured, home)
    : transcript ?? (typeof value?.["session_id"] === "string" ? await identities.bySession(value["session_id"]) : null);
  if (profile) return await identities.account(profile);
  const weekly = record(record(value?.["rate_limits"])?.["seven_day"])?.["resets_at"];
  return typeof weekly === "number" && Number.isFinite(weekly) ? weeklyPhaseKey(weekly) : "";
}

export function emptyLimitsSnapshot(dataSource: "live" | "snapshot", now = Date.now() / 1000): LimitsSnapshot {
  return {
    schemaVersion: 2, generatedAt: new Date(now * 1000).toISOString(), dataSource, persisted: false, ledger: "off", plans: { claude: null, codex: null },
    sources: [], observations: [], accounts: [], meters: [], resetCreditHistory: [], codexAccount: "off",
  };
}
