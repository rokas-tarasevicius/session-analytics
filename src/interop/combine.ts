import { createHash } from "node:crypto";
import { InteropError } from "./error.ts";
import { validateSnapshot } from "./snapshot.ts";
import type { HistoryCoverage, HistoryMonth, HistoryProfile } from "../metrics/history-types.ts";
import type { MachineAnalytics, MachineStatus, McpSourceHealth, RepositoryRollup, SessionAnalytics } from "../types.ts";
import { aggregateSessions } from "../public/export-data.js";
import { duplicateMachineWarning } from "../public/evidence.js";
import { timestampMilliseconds } from "../public/timestamps.js";

// Counted coverage warnings describe one input's sessions; they are recomputed for the union.
const counted = (warning: string): boolean => /^\d/.test(warning);
const unique = (values: string[]): string[] => [...new Set(values)];

/** Later activity, then more requests, marks the more complete copy of one provider session. */
function moreComplete(candidate: SessionAnalytics, current: SessionAnalytics): boolean {
  const last = (session: SessionAnalytics): number => {
    const time = session.lastEventAt === null ? Number.NaN : timestampMilliseconds(session.lastEventAt);
    return Number.isFinite(time) ? time : -Infinity;
  };
  return last(candidate) > last(current) || (last(candidate) === last(current) && candidate.metrics.modelCalls > current.metrics.modelCalls);
}

/** Profiles stay per machine. Month totals are rebuilt from those profiles and the combined sessions, as the validator does. */
function combineHistory(snapshots: MachineAnalytics[], profiles: HistoryProfile[], sessions: SessionAnalytics[]): HistoryCoverage | undefined {
  const sources = snapshots.flatMap(({ historyCoverage }) => historyCoverage ? [historyCoverage] : []);
  if (!sources.length) return undefined;
  const months = new Map<string, HistoryMonth>();
  const month = (id: string): HistoryMonth => {
    let row = months.get(id);
    if (!row) {
      row = { month: id, sessionsWithDatedValue: 0, statisticsCells: 0, sessionEvidenceUsd: 0, unattributedEstimateUsd: 0, unattributedTokens: 0, pricedUnattributedTokens: 0, possibleOverlapTokens: 0, recoveredMessageUsd: 0 };
      months.set(id, row);
    }
    return row;
  };
  for (const profile of profiles) for (const { month: id, models } of profile.months) {
    const row = month(id);
    for (const model of models) {
      row.statisticsCells += model.statisticsDays; row.unattributedTokens += model.unattributedTokens;
      row.pricedUnattributedTokens += model.pricedUnattributedTokens; row.possibleOverlapTokens += model.possibleOverlapTokens;
      row.unattributedEstimateUsd += model.unattributedEstimateUsd;
    }
  }
  let undatedSessionValueUsd = 0, unassignedProfileTokens = 0;
  for (const session of sessions) {
    let dated = 0;
    const seen = new Set<string>();
    for (const [day, value] of Object.entries(session.spendByDay)) {
      const row = month(day.slice(0, 7));
      row.sessionEvidenceUsd += value; dated += value;
      if (!seen.has(row.month)) { seen.add(row.month); row.sessionsWithDatedValue += 1; }
    }
    for (const bucket of session.history?.days ?? []) {
      month(bucket.day.slice(0, 7)).recoveredMessageUsd += bucket.valueUsd;
      unassignedProfileTokens += bucket.tokens;
    }
    unassignedProfileTokens += session.history?.undatedTokens ?? 0;
    undatedSessionValueUsd += Math.max(0, session.cost.totalUsd - dated);
  }
  // Calibration ratios cannot be pooled without their pairs; the first machine's calibration is kept.
  const calibration = sources.find(({ recoveryCalibration }) => recoveryCalibration)?.recoveryCalibration;
  return {
    ...(calibration ? { recoveryCalibration: calibration } : {}),
    version: 1, scope: "machine", profiles,
    months: [...months.values()].sort((left, right) => left.month.localeCompare(right.month)),
    undatedSessionValueUsd, unassignedProfileTokens,
  };
}

function combineSourceHealth(snapshots: MachineAnalytics[]): McpSourceHealth[] | undefined {
  const sources = snapshots.flatMap(({ mcpSourceHealth }) => mcpSourceHealth ? [mcpSourceHealth] : []);
  if (!sources.length) return undefined;
  const rows = new Map<McpSourceHealth["provider"], McpSourceHealth>();
  for (const row of sources.flat()) {
    const total = rows.get(row.provider) ?? { provider: row.provider, status: "unknown", sourcesRead: 0, missingSources: 0, unreadableSources: 0 };
    total.sourcesRead += row.sourcesRead; total.missingSources += row.missingSources; total.unreadableSources += row.unreadableSources;
    rows.set(row.provider, total);
  }
  // The same rule as one machine's discovery: every source, wherever it lives, counts.
  for (const row of rows.values()) row.status = !row.sourcesRead ? "unavailable" : row.missingSources || row.unreadableSources ? "incomplete" : "available";
  return [...rows.values()];
}

export interface CombineOptions {
  /** Fixed warnings to add, such as a machine that could not be read. */
  warnings?: string[];
  /**
   * How each input was read, in input order. Without them, an input keeps the machines it lists
   * (a combined file) or becomes machine-1, machine-2… A null input is a machine with no snapshot.
   */
  machines?: Array<MachineStatus | undefined>;
}

/** Keys and labels stay unique when combined files name the same machine. */
function uniqueIn(taken: Set<string>, value: string, suffix: (attempt: number) => string): string {
  let result = value;
  for (let attempt = 2; taken.has(result); attempt++) result = suffix(attempt);
  taken.add(result);
  return result;
}

/**
 * One validated snapshot from full snapshots of several machines. Sessions are unioned by provider
 * session key and repositories by ID; the first input names a repository and wins exact ties. A copy
 * read now beats a stale one, whichever is more complete. Every rollup, coverage warning and history
 * month is recomputed from the union rather than added. Combining more than one input, or describing
 * how inputs were read, lists the machines and tags each session and profile with its machine.
 */
export function combineSnapshots(inputs: ReadonlyArray<MachineAnalytics | null>, { warnings = [], machines: statuses }: CombineOptions = {}): MachineAnalytics {
  const snapshots = inputs.filter((snapshot): snapshot is MachineAnalytics => snapshot !== null);
  const first = snapshots[0];
  if (!first) throw new InteropError("Combining requires at least one full snapshot.");
  // Hourly cells are local to the analysis time zone; mixing zones would misplace activity.
  if (snapshots.some(({ velocity }) => velocity?.version !== first.velocity?.version || velocity?.timeZone !== first.velocity?.timeZone)) {
    throw new InteropError("Snapshots use different analysis time zones; create each with the same --time-zone.");
  }
  const described = statuses !== undefined || inputs.length > 1 || snapshots.some(({ machines }) => machines?.length);
  const machines: MachineStatus[] = [], keys = new Set<string>(), labels = new Set<string>();
  const sources = inputs.map((snapshot, position) => {
    const given = statuses?.[position];
    if (!given && !snapshot) throw new InteropError("Combining requires a status for a machine without a snapshot.");
    const own: MachineStatus[] = given ? [given] : snapshot!.machines?.length ? snapshot!.machines : [{
      key: `machine-${position + 1}`, label: `machine-${position + 1}`, state: "ok", sessions: snapshot!.summary.sessions,
      repositories: snapshot!.summary.repositories, readAt: snapshot!.generatedAt, durationMs: null, version: null,
    }];
    const remap = new Map<string, string>();
    for (const { identity: _, ...status } of own) {
      const key = uniqueIn(keys, status.key, (attempt) => `${status.key.slice(0, 60)}-${attempt}`);
      const label = uniqueIn(labels, status.label, (attempt) => `${status.label.slice(0, 248)} (${attempt})`);
      const scoped = own.length === 1 && snapshot && !snapshot.machines?.length ? unique(snapshot.warnings.filter((warning) => !counted(warning))) : status.warnings;
      remap.set(status.key, key);
      machines.push({ ...status, key, label, ...(scoped?.length ? { warnings: scoped } : {}) });
    }
    // Freshness is per session: a combined file read now still carries its stale machines' sessions.
    const states = new Map(own.map(({ key, state }) => [key, state]));
    const fresh = (machine: string | undefined): boolean => ((machine !== undefined ? states.get(machine) : undefined) ?? own[0]!.state) === "ok";
    return { snapshot, remap, fallback: remap.get(own[0]!.key)!, fresh };
  });
  const sessions = new Map<string, { session: SessionAnalytics; fresh: boolean }>();
  const profiles: HistoryProfile[] = [], profileKeys = new Set<string>();
  let generatedAt = first.generatedAt;
  let duplicates = false;
  for (const [position, { snapshot, remap, fallback, fresh }] of sources.entries()) {
    if (!snapshot) continue;
    if (timestampMilliseconds(snapshot.generatedAt) > timestampMilliseconds(generatedAt)) generatedAt = snapshot.generatedAt;
    const machineOf = (key: string | undefined): string => (key !== undefined ? remap.get(key) : undefined) ?? fallback;
    const remappedProfiles = new Map<string, string>();
    for (const profile of snapshot.historyCoverage?.profiles ?? []) {
      let key = profile.profileKey, attempt = 0;
      // Matching directory hashes do not identify a shared source across machines.
      while (profileKeys.has(key)) key = `profile-${createHash("sha256").update(`${profile.profileKey}:${position}:${attempt++}`).digest("hex").slice(0, 20)}`;
      profileKeys.add(key); remappedProfiles.set(profile.profileKey, key);
      const { machine, ...rest } = profile;
      profiles.push({ ...rest, profileKey: key, ordinal: profiles.length + 1, ...(described ? { machine: machineOf(machine) } : {}) });
    }
    for (const session of snapshot.sessions) {
      const key = `${session.provider}:${session.sessionKey}`;
      const current = sessions.get(key), now = fresh(session.machine);
      if (current) duplicates = true;
      if (!current || (now !== current.fresh ? now : moreComplete(session, current.session))) {
        const profileKey = session.historyProfile ? remappedProfiles.get(session.historyProfile.profileKey) : undefined;
        const { machine, ...rest } = session;
        sessions.set(key, { fresh: now, session: {
          ...rest,
          ...(profileKey && profileKey !== session.historyProfile?.profileKey ? { historyProfile: { profileKey, days: session.historyProfile!.days } } : {}),
          ...(described ? { machine: machineOf(machine) } : {}),
        } });
      }
    }
  }
  const repositories = new Map<string, { name: string; warnings: string[]; sessions: SessionAnalytics[] }>();
  const machineWarnings: string[] = [];
  for (const snapshot of snapshots) {
    machineWarnings.push(...snapshot.warnings.filter((warning) => !counted(warning)));
    for (const { repository, warnings: repositoryWarnings } of snapshot.repositories) {
      const row = repositories.get(repository.id) ?? { name: repository.name, warnings: [], sessions: [] };
      row.warnings.push(...repositoryWarnings.filter((warning) => !counted(warning)));
      repositories.set(repository.id, row);
    }
  }
  for (const { session } of sessions.values()) {
    const row = repositories.get(session.repositoryId);
    // Validated inputs always list their sessions' repositories.
    if (!row) throw new InteropError("Snapshot is invalid, inconsistent, or unsupported.");
    row.sessions.push(row.name === session.repositoryName ? session : { ...session, repositoryName: row.name });
  }
  const ordered = [...repositories].sort(([, left], [, right]) => left.name.localeCompare(right.name));
  const rollups: RepositoryRollup[] = ordered.map(([id, row]) => {
    const rollup = aggregateSessions(row.sessions);
    return { repository: { id, name: row.name }, ...rollup, warnings: unique([...row.warnings, ...rollup.warnings]) };
  });
  const selected = ordered.flatMap(([, row]) => row.sessions);
  const combined = aggregateSessions(selected);
  const models = new Map<string, MachineAnalytics["rateCard"]["models"][number]>();
  for (const snapshot of snapshots) for (const model of snapshot.rateCard.models) if (!models.has(model.model)) models.set(model.model, model);
  const history = combineHistory(snapshots, profiles, selected);
  const health = combineSourceHealth(snapshots);
  return validateSnapshot({
    ...(described ? { machines } : {}),
    ...(first.velocity ? { velocity: first.velocity } : {}),
    generatedAt,
    schemaVersion: 1,
    rateCard: { ...first.rateCard, models: [...models.values()] },
    repositories: rollups,
    sessions: selected,
    spendByDay: combined.spendByDay,
    spendByModel: combined.spendByModel,
    summary: {
      ...combined.summary,
      repositories: rollups.length,
      repositoriesWithSessions: rollups.filter(({ summary }) => summary.sessions > 0).length,
      workingSnapshots: selected.filter(({ transcript }) => transcript.snapshotWhileWorking && !transcript.sourceDeleted &&
        !transcript.warnings.includes("Source availability could not be checked; showing the last indexed facts.")).length,
    },
    topTools: combined.topTools,
    warnings: unique([...combined.warnings, ...machineWarnings, ...(duplicates ? [duplicateMachineWarning] : []), ...warnings]),
    ...(history ? { historyCoverage: history } : {}),
    ...(health ? { mcpSourceHealth: health } : {}),
    ...(first.mcpContext ? { mcpContext: first.mcpContext } : {}),
  });
}
