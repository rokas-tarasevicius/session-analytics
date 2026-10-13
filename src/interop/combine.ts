import { InteropError } from "./error.ts";
import { validateSnapshot } from "./snapshot.ts";
import type { HistoryCoverage, HistoryMonth, HistoryProfile } from "../metrics/history-types.ts";
import type { MachineAnalytics, McpSourceHealth, RepositoryRollup, SessionAnalytics } from "../types.ts";
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
function combineHistory(snapshots: MachineAnalytics[], sessions: SessionAnalytics[]): HistoryCoverage | undefined {
  const sources = snapshots.flatMap(({ historyCoverage }) => historyCoverage ? [historyCoverage] : []);
  if (!sources.length) return undefined;
  const profiles: HistoryProfile[] = [], keys = new Set<string>();
  for (const profile of sources.flatMap(({ profiles: rows }) => rows)) {
    // A profile key hashes its directory: the same key from two inputs is one profile observed twice.
    if (keys.has(profile.profileKey)) continue;
    keys.add(profile.profileKey);
    profiles.push({ ...profile, ordinal: profiles.length + 1 });
  }
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

/**
 * One validated snapshot from full snapshots of several machines. Sessions are unioned by provider
 * session key and repositories by ID; the first input names a repository and wins exact ties. Every
 * rollup, coverage warning and history month is recomputed from the union rather than added.
 */
export function combineSnapshots(snapshots: MachineAnalytics[], warnings: string[] = []): MachineAnalytics {
  const first = snapshots[0];
  if (!first) throw new InteropError("Combining requires at least one full snapshot.");
  // Hourly cells are local to the analysis time zone; mixing zones would misplace activity.
  const zone = JSON.stringify(first.velocity ?? null);
  if (snapshots.some(({ velocity }) => JSON.stringify(velocity ?? null) !== zone)) {
    throw new InteropError("Snapshots use different analysis time zones; create each with the same --time-zone.");
  }
  const sessions = new Map<string, SessionAnalytics>();
  let duplicates = false;
  for (const snapshot of snapshots) for (const session of snapshot.sessions) {
    const key = `${session.provider}:${session.sessionKey}`;
    const current = sessions.get(key);
    if (current) duplicates = true;
    if (!current || moreComplete(session, current)) sessions.set(key, session);
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
  for (const session of sessions.values()) {
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
  const history = combineHistory(snapshots, selected);
  const health = combineSourceHealth(snapshots);
  return validateSnapshot({
    ...(first.velocity ? { velocity: first.velocity } : {}),
    generatedAt: first.generatedAt,
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
