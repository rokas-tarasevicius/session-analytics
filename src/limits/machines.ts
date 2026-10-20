import { createHash } from "node:crypto";

import { profileKeyRemaps } from "../interop/combine.ts";
import { lastGoodMaxAgeMs, readLastGoodLimits, writeLastGoodLimits } from "../machines/cache.ts";
import { byHostName, localIdentity } from "../machines/identity.ts";
import type { RemoteMachine, RemoteOptions } from "../options.ts";
import { stopping } from "../processes.ts";
import { localMachine, machineAge } from "../public/machines.js";
import { meterLabel } from "../public/subscription-data.js";
import { classifyRemote, machineKeys, RemoteError, remoteVersion, requestDigest, runRemote, targetDigest } from "../remote.ts";
import { dataDirectory } from "../store/database.ts";
import { version } from "../version.ts";
import { accountAttribution, accountLabel, identified } from "./accounts.ts";
import { accountActivity, accountOrder, activePlans, meterInfos, resolveCaps, type LimitsOptions } from "./index.ts";
import { compactObservations, emptyLedger, ledgerAccount, resetCreditHistory, toRow, validObservation, writeLedger, type LedgerAccount } from "./ledger.ts";
import type { ClaudeAccountSummary, CodexAccountSummary, LimitAccount, LimitObservation, LimitsMachine, LimitsSnapshot } from "./types.ts";

/**
 * A harvest after a machine's first takes seconds: once it has answered, a read that has not answered in a minute (or in
 * --remote-timeout, if shorter) is stopped.
 */
export const limitsTimeoutMs = 60_000;
const maximumLimitsBytes = 64 * 1024 * 1024;

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const time = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 1_500_000_000 && value <= 4_000_000_000 ? Math.floor(value) : null;
const digest = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 16);
const list = (value: unknown, limit: number): unknown[] => {
  if (!Array.isArray(value) || value.length > limit) throw new Error("invalid");
  return value;
};
const meterTitlePattern = /^[A-Za-z0-9][A-Za-z0-9 ._·-]{0,79}$/;
const profileNamePattern = /^[A-Za-z0-9._-]{1,40}$/;

/**
 * What each other machine runs: its own harvest and ledger, never further machines, with full Claude readings left
 * unsettled so they are settled once, with the merged account's extra-usage state. Its Codex app-server is asked only
 * with `codexAccount`.
 */
export function limitsArguments(options: Pick<LimitsOptions, "offline" | "noIndex">, codexAccount: boolean): string[] {
  return ["limits", "--json", "--no-remote", "--unsettled", ...(options.offline ? ["--offline"] : []), ...(options.noIndex ? ["--no-index"] : []), ...(codexAccount ? [] : ["--no-codex-account"])];
}

function remoteAccount(value: unknown): LimitAccount | null {
  const item = record(value), key = item?.["key"];
  const account = typeof key === "string" ? ledgerAccount(key, item) : null;
  if (!item || !account) return null;
  const names = Array.isArray(item["profileNames"]) ? item["profileNames"].filter((name): name is string => typeof name === "string" && profileNamePattern.test(name)) : [];
  const profileNames = [...new Set(names)].slice(0, 32), weeklyAnchor = time(item["weeklyAnchor"]);
  return {
    key: key as string, provider: account.provider, attribution: accountAttribution(key as string),
    label: accountLabel(account.provider, key as string, account.plan, profileNames, weeklyAnchor), profileNames, profileKeys: account.profileKeys,
    plan: account.plan, planSource: account.planSource, planEvidence: account.planEvidence, planObservedAt: account.planObservedAt,
    extraUsage: account.extraUsage, codex: account.codex, weeklyAnchor, lastSeen: time(item["lastSeen"]),
  };
}

/**
 * Another machine's limits, re-validated field by field through the ledger's allowlists, so nothing it sends widens the
 * contract. Account labels are rebuilt here from the plan and plain profile names, and its source health is dropped:
 * the Sources table describes this machine.
 */
export function validateLimitsSnapshot(value: unknown): LimitsSnapshot {
  const snapshot = record(value), generatedAt = Date.parse(typeof snapshot?.["generatedAt"] === "string" ? snapshot["generatedAt"] : "");
  if (!snapshot || snapshot["schemaVersion"] !== 2 || snapshot["dataSource"] !== "live" || !Number.isFinite(generatedAt)) throw new Error("invalid");
  const observations = list(snapshot["observations"], 1_000_000).flatMap((row) => {
    const valid = record(row) ? validObservation(row as unknown as LimitObservation) : null;
    return valid ? [valid] : [];
  });
  const accounts = list(snapshot["accounts"], 4096).map(remoteAccount).filter((account): account is LimitAccount => account !== null).sort(accountOrder);
  const titles = new Map<string, string>();
  for (const item of list(snapshot["meters"], 100_000)) {
    const meter = record(item);
    if (meter && typeof meter["label"] === "string" && meterTitlePattern.test(meter["label"])) titles.set(`${String(meter["provider"])}|${String(meter["account"])}|${String(meter["meter"])}`, meter["label"]);
  }
  const ledger = snapshot["ledger"], codexAccount = snapshot["codexAccount"];
  return {
    schemaVersion: 2, generatedAt: new Date(generatedAt).toISOString(), dataSource: "live", persisted: snapshot["persisted"] === true,
    ledger: ledger === "ok" || ledger === "unreadable" || ledger === "unwritable" ? ledger : "off",
    plans: activePlans(accounts), sources: [], observations, accounts,
    meters: meterInfos(observations, (row) => titles.get(`${row.provider}|${row.account}|${row.meter}`) ?? meterLabel(row.meter)),
    resetCreditHistory: resetCreditHistory(snapshot["resetCreditHistory"]),
    codexAccount: codexAccount === "ok" || codexAccount === "unavailable" ? codexAccount : "off",
  };
}

const identityPattern = /^(?:host-)?[0-9a-f]{16}$/;

/**
 * One machine's validated limits, and the hash of the machine and account that answered when it was asked
 * (`--identify-machine`). An installed remote that fails as if it ran another version is asked which.
 */
export async function fetchRemoteLimits(machine: RemoteMachine, args: string[], { timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal }): Promise<{ snapshot: LimitsSnapshot; identity: string | null }> {
  const result = await runRemote(machine, args, { deadline: Date.now() + timeoutMs, signal, limit: maximumLimitsBytes });
  let failure = classifyRemote(machine, result, timeoutMs);
  // A limits read's time-out and size limit are its own, and so are their fixes.
  if (failure?.reason === "timeout" || failure?.reason === "too-large") failure = new RemoteError(failure.reason, machine, result.stderr, "limits", timeoutMs);
  let snapshot: LimitsSnapshot | null = null, identity: string | null = null;
  if (!failure) {
    try {
      const value: unknown = JSON.parse(result.stdout.toString("utf8"));
      snapshot = validateLimitsSnapshot(value);
      const self = record(list(record(value)?.["machines"] ?? [], 1)[0])?.["identity"];
      identity = typeof self === "string" && identityPattern.test(self) ? self : null;
    } catch { failure = new RemoteError("invalid", machine, "", "limits --json"); }
  }
  if (failure && machine.runtime === "installed" && ["rejected", "invalid", "analysis"].includes(failure.reason)) {
    const found = await remoteVersion(machine, signal);
    if (found && found !== version) throw new RemoteError("version-skew", machine, result.stderr, found);
  }
  if (failure) throw failure;
  return { snapshot: snapshot!, identity };
}

/**
 * Another machine's readings and plans, kept in this machine's ledger so their history outlives that machine and its log
 * rotation. Only real accounts (keys of a login, which are the same on every machine) are kept, under that key; a
 * machine is irrelevant to an account-wide meter. Profile keys, profile names and current account state stay with the
 * machine that reported them. Its plans carry no time, so they fill in only an account this machine never read a plan
 * for: the ledger's plan stays this machine's own reading. The ledger merges and compacts them like any other writer's.
 */
export function foldMachineLimits(directory: string, snapshot: LimitsSnapshot, now = Date.now() / 1000): void {
  const accounts: Record<string, LedgerAccount> = {};
  for (const account of snapshot.accounts) {
    if (account.attribution !== "account") continue;
    accounts[account.key] = { provider: account.provider, plan: account.plan, planSource: account.planSource, planEvidence: account.planEvidence, planObservedAt: null, extraUsage: null, codex: null, profileKeys: [] };
  }
  const rows = snapshot.observations.filter((row) => accounts[row.account]?.provider === row.provider).map(toRow);
  if (!rows.length) return;
  writeLedger(directory, { ...emptyLedger(), accounts, rows, resetCreditHistory: snapshot.resetCreditHistory.filter((row) => accounts[row[1]]) }, now);
}

/** One machine in a merge: how it was read and its validated limits (read now, or its last good ones while stale or reading). */
export interface MachineLimits {
  status: LimitsMachine;
  snapshot: LimitsSnapshot | null;
}

/**
 * Claude extra usage defaults to the profile's `hasExtraUsageEnabled`, stamped with the harvest time, until the account's
 * own events say more. Such a default never replaces an event read on another machine.
 */
const profileDefault = (summary: ClaudeAccountSummary, generatedAt: string): boolean =>
  summary.observedAt === Math.floor(Date.parse(generatedAt) / 1000) && summary.disabledReason === null && summary.extraUsage !== "in-use";

const newest = <T extends { observedAt: number }>(items: T[]): T | null => items.reduce<T | null>((best, item) => !best || item.observedAt > best.observedAt ? item : best, null);

/** The freshest Codex account state; banked resets and `ordinaryUsageAllowed` from the freshest reading that has them. */
function freshestCodex(summaries: CodexAccountSummary[]): CodexAccountSummary | null {
  const latest = newest(summaries);
  if (!latest) return null;
  return { ...latest, resetCredits: newest(summaries.filter((item) => item.resetCredits))?.resetCredits ?? null,
    ordinaryUsageAllowed: newest(summaries.filter((item) => item.ordinaryUsageAllowed !== null))?.ordinaryUsageAllowed ?? null };
}

/** A Max plan inferred from the organization type without its rate-limit tier (`claudePlanOf`) is a guess another machine's tier settles. */
const guessed = ({ plan, planSource, planEvidence }: LimitAccount): boolean =>
  plan === "max-5x" && planSource === "claude-config" && !/max_5x/.test(`${planEvidence?.organizationRateLimitTier} ${planEvidence?.userRateLimitTier}`);

/**
 * Accounts with one key from several machines are one account: the newest plan that is not a guess, the freshest state, the
 * first machine's profile names. A Claude plan's time is when that machine first read it as it is, and a Codex plan's when
 * Codex reported it, so the newest is the latest change, however recently each machine was read.
 */
function mergeAccount(versions: Array<{ account: LimitAccount; generatedAt: string }>, names: string[]): Omit<LimitAccount, "label" | "weeklyAnchor" | "lastSeen"> {
  const accounts = versions.map(({ account }) => account), first = accounts[0]!;
  const planned = accounts.filter((account) => account.planObservedAt !== null).sort((left, right) => Number(guessed(left)) - Number(guessed(right)) || right.planObservedAt! - left.planObservedAt!)[0]
    ?? accounts.find((account) => account.plan) ?? first;
  const extra = versions.flatMap(({ account, generatedAt }) => account.extraUsage ? [{ summary: account.extraUsage, event: !profileDefault(account.extraUsage, generatedAt) }] : []);
  const events = extra.filter((item) => item.event);
  return {
    key: first.key, provider: first.provider, attribution: first.attribution, profileNames: names,
    profileKeys: [...new Set(accounts.flatMap((account) => account.profileKeys))].slice(0, 64),
    plan: planned.plan, planSource: planned.planSource, planEvidence: planned.planEvidence ?? accounts.find((account) => account.planEvidence)?.planEvidence ?? null, planObservedAt: planned.planObservedAt,
    extraUsage: newest((events.length ? events : extra).map((item) => item.summary)),
    codex: first.provider === "codex" ? freshestCodex(accounts.flatMap((account) => account.codex ? [account.codex] : [])) : null,
  };
}

/** A profile key (`claude-p-…`) hashes a path on its machine, which another machine can share, so it is qualified by the machine. */
const qualified = (key: string, machine: string): string =>
  accountAttribution(key) === "profile" ? `${key.slice(0, key.indexOf("-p-"))}-p-${digest(`session-analytics/limits/machine-profile/v1\0${machine}\0${key}`)}` : key;

/**
 * This machine's harvest merged with every other machine's limits, then settled (`resolveCaps`) with the merged accounts.
 *
 * - Accounts with the same key are one account, whichever machines report it: account keys hash the login, so they agree
 *   across machines. Readings are unioned and compacted like the ledger does, so a duplicate counts once and every
 *   machine's readings of a cycle stay: the meter is account-wide.
 * - Readings no machine could attribute (unattributed and weekly-phase groups) are never merged across machines: only
 *   this machine's are kept. Another machine's profile keys (`claude-p-…`) are qualified by that machine.
 * - Each account lists the machines logged into it (`machines`), with Claude profile keys remapped as the combined
 *   snapshot remaps them (`remaps`, by machine key; without them, as `combineSnapshots` would for these profiles), so
 *   sessions join by machine and profile key.
 */
export function mergeMachineLimits(local: LimitsSnapshot, localStatus: LimitsMachine, others: MachineLimits[], remaps: Map<string, Map<string, string>> | null = null, now = Date.now() / 1000): LimitsSnapshot {
  if (!others.length) return { ...local, observations: resolveCaps(local.observations, local.accounts) };
  const parts: MachineLimits[] = [{ status: localStatus, snapshot: local }, ...others];
  const fallback = profileKeyRemaps(parts.map(({ snapshot }) => snapshot ? [...new Set(snapshot.accounts.filter((account) => account.provider === "claude").flatMap((account) => account.profileKeys))] : null));
  const versions = new Map<string, Array<{ account: LimitAccount; generatedAt: string }>>();
  const places = new Map<string, Array<{ key: string; profileKeys: string[] }>>(), names = new Map<string, string[]>();
  const rows: LimitObservation[] = [], titles = new Map<string, string>(), history: LimitsSnapshot["resetCreditHistory"] = [];
  for (const [position, { status, snapshot }] of parts.entries()) {
    if (!snapshot) continue;
    const own = position === 0, remap = remaps?.get(status.key) ?? new Map(fallback[position]);
    const keyOf = (key: string): string | null => own ? key : identified(key) ? qualified(key, status.key) : null;
    for (const account of snapshot.accounts) {
      const key = keyOf(account.key);
      if (key === null) continue;
      versions.set(key, [...versions.get(key) ?? [], { account: { ...account, key }, generatedAt: snapshot.generatedAt }]);
      // A machine reports an account when one of its profiles or homes is logged into it, not when it only keeps its history.
      if (!identified(key) || (!account.profileKeys.length && !account.profileNames.length)) continue;
      places.set(key, [...places.get(key) ?? [], { key: status.key, profileKeys: account.provider === "claude" ? account.profileKeys.map((profile) => remap.get(profile) ?? profile) : account.profileKeys }]);
      if (!names.has(key) && account.profileNames.length) names.set(key, account.profileNames);
    }
    for (const row of snapshot.observations) { const key = keyOf(row.account); if (key !== null) rows.push(key === row.account ? row : { ...row, account: key }); }
    for (const meter of snapshot.meters) { const key = keyOf(meter.account); if (key !== null && !titles.has(`${meter.provider}|${key}|${meter.meter}`)) titles.set(`${meter.provider}|${key}|${meter.meter}`, meter.label); }
    for (const row of snapshot.resetCreditHistory) { const key = keyOf(row[1]); if (key !== null) history.push([row[0], key, row[2], row[3]]); }
  }
  const observations = compactObservations(rows, now), { lastSeen, anchors } = accountActivity(observations);
  const keys = new Set([...observations.map((row) => row.account), ...[...places.keys()]]);
  const accounts = [...keys].flatMap((key) => {
    const found = versions.get(key);
    if (!found) return [];
    const merged = mergeAccount(found, names.get(key) ?? []), id = `${merged.provider}|${key}`, weeklyAnchor = anchors.get(id) ?? null;
    return [{
      ...merged, label: accountLabel(merged.provider, key, merged.plan, merged.profileNames, weeklyAnchor), weeklyAnchor, lastSeen: lastSeen.get(id) ?? null,
      machines: places.get(key) ?? [],
    } satisfies LimitAccount];
  }).sort(accountOrder);
  return {
    ...local, plans: activePlans(accounts), observations: resolveCaps(observations, accounts), accounts,
    meters: meterInfos(observations, (row) => titles.get(`${row.provider}|${row.account}|${row.meter}`) ?? meterLabel(row.meter)),
    resetCreditHistory: resetCreditHistory(history), machines: parts.map(({ status }) => status),
  };
}

/** One other machine's limits read: how it stands, its limits, and whether its next read also asks its Codex app-server. */
export interface LimitsReading extends MachineLimits {
  machine: RemoteMachine;
  pending: Promise<void> | null;
  /** Null until known: true when it reports a Codex account whose banked resets this machine's own account read does not know. */
  codexAccount: boolean | null;
  /** Hash of the machine ID and account that answered, else the one `machines check` recorded. */
  identity?: string;
  /** The machine this one duplicates, once reported; reported again only after it stopped being one. */
  twin?: string;
}

export interface LimitsReads {
  readings: LimitsReading[];
  /** Settles when last good limits are loaded for machines not read yet (with `preload`). */
  loaded: Promise<void>;
  /**
   * Read every machine that is not reading now, while this machine harvests (`local`, which decides whether a machine
   * should also ask its Codex app-server). Resolves when those reads have settled.
   */
  start(local: Promise<LimitsSnapshot | null>): Promise<void>;
  abort(): void;
  /** Every machine's limits as they stand, for `mergeMachineLimits`: a machine reached twice counts once. */
  current(): MachineLimits[];
}

/** Codex accounts a machine reports whose banked resets this machine's harvest does not know. */
const unknownBankedResets = (remote: LimitsSnapshot, local: LimitsSnapshot): boolean => remote.accounts.some((account) => account.provider === "codex" &&
  account.attribution === "account" && account.profileKeys.length > 0 && !local.accounts.some((own) => own.key === account.key && own.codex?.resetCredits));

/** The terminal lines for a machine whose limits could not be read: why, what to run, and what is shown instead. */
export function limitsReadLines(machine: RemoteMachine, status: LimitsMachine, error: RemoteError): string {
  const stale = status.state === "stale" ? `\n  Using its last good limits from ${machineAge(status.readAt) ?? "an earlier read"}.` : "";
  return `Could not read limits from ${machine.name}: ${error.message}.${error.detail ? ` ${error.detail}` : ""}${error.fix ? `\n  Fix: ${error.fix}` : ""}${stale}`;
}

/**
 * Reads other machines' limits through the same ssh and bundled runtime as their snapshots, each on its own. A failed read
 * keeps the machine's last good limits (from this process, else from the data directory for a saved machine), marked
 * stale. A fresh read is folded into this machine's ledger (`foldMachineLimits`) unless the ledger is off. A failure is
 * reported once, until its reason changes. A machine's first harvest reads weeks of records, so until it has answered
 * once (or has last good limits), its read may take the whole --remote-timeout; later reads stop after a minute.
 */
export function limitsReads(
  options: LimitsOptions, remote: RemoteOptions,
  { report = () => {}, signal, preload = false, environment = process.env }: { report?: (line: string) => void; signal?: AbortSignal; preload?: boolean; environment?: NodeJS.ProcessEnv } = {},
): LimitsReads {
  const persist = options.noIndex !== true && environment["SESSION_ANALYTICS_NO_INDEX"] !== "1";
  const offline = options.offline === true || environment["SESSION_ANALYTICS_OFFLINE"] === "1";
  // The user's switches apply everywhere: no machine asks its app-server with --no-codex-account or --offline.
  const accountRead = options.codexAccount !== false && !offline && environment["SESSION_ANALYTICS_CODEX_ACCOUNT"] !== "0";
  const args = (codexAccount: boolean): string[] => limitsArguments({ offline, noIndex: !persist }, codexAccount);
  const request = requestDigest(args(true));
  let controller = new AbortController();
  const abort = (): void => { controller.abort(); controller = new AbortController(); };
  signal?.addEventListener("abort", abort, { once: true });
  const keys = machineKeys(remote.machines);
  const readings: LimitsReading[] = remote.machines.map((machine, index) =>
    ({ machine, snapshot: null, pending: null, codexAccount: null, status: { key: keys[index]!, label: machine.name, state: "reading", readAt: null, durationMs: null } }));
  const lastGood = async ({ machine, status }: LimitsReading): Promise<Pick<LimitsReading, "snapshot" | "status" | "codexAccount"> | null> => {
    const found = machine.saved ? await readLastGoodLimits(options, status.key, { request, target: targetDigest(machine) }, validateLimitsSnapshot) : null;
    return found && { snapshot: found.limits, codexAccount: found.record.codexAccount, status: { key: status.key, label: status.label, state: "stale", readAt: found.record.readAt, durationMs: found.record.durationMs } };
  };
  const loaded = Promise.all(readings.map(async (reading) => {
    if (!preload) return;
    const found = await lastGood(reading);
    if (found && reading.status.state === "reading" && !reading.snapshot) Object.assign(reading, found, { status: { ...found.status, state: "reading" } });
  })).then(() => {});

  const reported = new Map<LimitsReading, string>();
  const read = async (reading: LimitsReading, stop: AbortSignal, local: Promise<LimitsSnapshot | null>): Promise<void> => {
    const { machine } = reading, { key, label } = reading.status;
    const started = performance.now();
    const self = (identity: string | null | undefined): boolean => Boolean(identity && !byHostName(identity) && identity === localIdentity());
    try {
      if (self(machine.identity)) throw new RemoteError("same-machine", machine);
      let answered = reading.snapshot !== null;
      if (reading.codexAccount === null) { const found = await lastGood(reading); reading.codexAccount = found?.codexAccount ?? false; answered ||= found !== null; }
      const timeoutMs = answered ? Math.min(remote.timeoutMs, limitsTimeoutMs) : remote.timeoutMs;
      // The bundled runtime says which machine and account answered, so one reached twice counts once.
      const ask = (codexAccount: boolean): string[] => [...args(codexAccount), ...(machine.runtime === "bundled" ? ["--identify-machine"] : [])];
      const asked = accountRead && reading.codexAccount;
      const fetched = await fetchRemoteLimits(machine, ask(asked), { timeoutMs, signal: stop }), identity = fetched.identity ?? machine.identity;
      if (self(identity)) throw new RemoteError("same-machine", machine);
      let answer = fetched.snapshot;
      let ms = performance.now() - started;
      const own = await local;
      // Banked resets are account-wide: a machine asks its own app-server only for an account this machine's read does not know.
      reading.codexAccount = own ? unknownBankedResets(answer, own) : reading.codexAccount;
      if (accountRead && reading.codexAccount && !asked) {
        const first = answer, again = performance.now();
        answer = await fetchRemoteLimits(machine, ask(true), { timeoutMs, signal: stop }).then((retried) => retried.snapshot, (error: unknown) => { if (stop.aborted || stopping()) throw error; return first; });
        ms += performance.now() - again;
      }
      const status: LimitsMachine = { key, label, state: "ok", readAt: new Date().toISOString(), durationMs: Math.round(ms) };
      Object.assign(reading, { snapshot: answer, status, identity });
      if (machine.saved) {
        // Profile directory names are local-only: they are shown while read, never stored.
        const limits = { ...answer, accounts: answer.accounts.map((item) => ({ ...item, profileNames: [], label: accountLabel(item.provider, item.key, item.plan, [], item.weeklyAnchor) })) };
        try { writeLastGoodLimits(options, key, { request, target: targetDigest(machine), readAt: status.readAt!, durationMs: status.durationMs!, codexAccount: reading.codexAccount, limits }); }
        catch { /* The cache only softens a later failure. */ }
      }
      if (persist) { try { foldMachineLimits(dataDirectory(options, environment), answer); } catch { /* That history is read again next time. */ } }
      reported.delete(reading);
    } catch (caught) {
      const stopped = stop.aborted || stopping();
      const error = stopped ? new RemoteError("cancelled", machine) : caught instanceof RemoteError ? caught : new RemoteError("analysis", machine);
      const age = reading.status.readAt ? Date.now() - Date.parse(reading.status.readAt) : Infinity;
      const kept = error.reason === "same-machine" ? null
        : reading.snapshot && age <= lastGoodMaxAgeMs ? { snapshot: reading.snapshot, status: reading.status }
        : stopped ? null : await lastGood(reading);
      const fix = error.snapshotFix ? { fix: error.snapshotFix } : {};
      if (kept) Object.assign(reading, kept, { status: { ...kept.status, state: "stale", reason: error.reason, ...fix } });
      else Object.assign(reading, { snapshot: null, identity: undefined, status: { key, label, state: "failed", reason: error.reason, ...fix, readAt: null, durationMs: null } });
      if (!stopped && reported.get(reading) !== error.reason) { reported.set(reading, error.reason); report(limitsReadLines(machine, reading.status, error)); }
    }
  };

  const start = (local: Promise<LimitsSnapshot | null>): Promise<void> => {
    const stop = controller.signal;
    for (const reading of readings) {
      if (reading.pending) continue;
      const { key, label, readAt, durationMs } = reading.status;
      reading.status = { key, label, state: "reading", readAt, durationMs };
      reading.pending = read(reading, stop, local).finally(() => { reading.pending = null; });
    }
    return Promise.all(readings.map(({ pending }) => pending)).then(() => {});
  };

  const current = (): MachineLimits[] => {
    // As for snapshots: answers read now win, in the configured order, then stale ones.
    const seen = new Map<string, string>([[localIdentity(), remote.local]]), twins = new Map<LimitsReading, string>();
    for (const reading of [...readings].sort((left, right) => Number(left.status.state !== "ok") - Number(right.status.state !== "ok"))) {
      const identity = reading.identity ?? reading.machine.identity;
      if (!reading.snapshot || !identity || byHostName(identity)) continue;
      const twin = seen.get(identity);
      if (twin) twins.set(reading, twin); else seen.set(identity, reading.machine.name);
    }
    return readings.map((reading) => {
      const twin = twins.get(reading);
      if (!twin) { reading.twin = undefined; return reading; }
      const error = new RemoteError("same-machine", reading.machine, "", twin), { key, label } = reading.status;
      if (reading.twin !== twin) { reading.twin = twin; report(`Not counting limits from ${reading.machine.name}: ${error.message}.${error.fix ? `\n  Fix: ${error.fix}` : ""}`); }
      return { snapshot: null, status: { key, label, state: "failed", reason: "same-machine", ...(error.snapshotFix ? { fix: error.snapshotFix } : {}), readAt: null, durationMs: null } };
    });
  };

  return { readings, loaded, start, abort, current };
}

/** This machine's status in a merge, from its own harvest. */
export const localLimitsMachine = (label: string, snapshot: LimitsSnapshot, durationMs: number): LimitsMachine =>
  ({ key: localMachine, label, state: "ok", readAt: snapshot.generatedAt, durationMs: Math.round(durationMs) });
