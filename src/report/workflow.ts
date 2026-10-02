import type { RepositoryRollup, WorkflowSummary } from "../types.ts";

const ms = (value: number | null): string => value === null ? "N/A" : value < 60_000 ? `${(value / 1000).toFixed(1)}s` : value < 3_600_000 ? `${(value / 60_000).toFixed(1)}m` : `${(value / 3_600_000).toFixed(1)}h`;
const count = (value: number | null): string => value === null ? "N/A" : value.toLocaleString("en-US");

export function workflowReport(w: WorkflowSummary, repositories: Pick<RepositoryRollup, "repository">[]): string {
  const names = new Map(repositories.map(({ repository }) => [repository.id, repository.name]));
  const a = w.autonomy, c = w.concurrency;
  const lines = [
    "\nWorkflow · observed events and labeled estimates",
    `Coverage: ${w.coverage.supportedSessions}/${w.coverage.sessions} sessions supported; ${w.coverage.timedSessions} timed; ${w.coverage.partialSessions} partial. Cursor timing unavailable.`,
    `Human turns: ${a.humanTurns} across ${w.coverage.humanSessions} primary sessions; mean ${a.turnsPerSession?.toFixed(1) ?? "N/A (minimum 5 sessions)"}.`,
    `Tools between human turns: p50 ${count(a.toolRuns.p50)}, max ${count(a.toolRuns.max)} (${a.toolRuns.samples} runs, includes zero-tool turns and final runs).`,
    `Turn wall time: p50 ${ms(a.turnWallTime.p50)}, p95 ${ms(a.turnWallTime.p95)} (${a.turnWallTime.samples} samples; ${a.recordedTurnDurations} recorded durations, ${a.inferredTurnDurations} event-derived).`,
    `Estimated agent activity: ${ms(w.time.activeMilliseconds)}; waiting for human: ${ms(w.time.waitingForHumanMilliseconds)}; idle/unclassified: ${ms(w.time.unclassifiedMilliseconds)}.`,
    "Activity joins work-event gaps up to 5m; waiting needs a terminal marker then a human and is capped at 30m. Permission waiting is unavailable.",
    `Concurrent sessions: peak ${c.peak}; effective parallelism ${c.effectiveParallelism?.toFixed(2) ?? "N/A"}× (${ms(c.activeSessionMilliseconds)} session activity / ${ms(c.wallClockActiveMilliseconds)} wall-clock activity; ${c.eligibleSessions} active sessions; minimum 1m wall time).`,
  ];
  for (const repo of w.repositories.filter((r) => r.peak > 0).sort((a, b) => b.peak - a.peak).slice(0, 10)) {
    lines.push(`  ${names.get(repo.repositoryId) ?? "Repository"}: peak ${repo.peak}, ${repo.effectiveParallelism?.toFixed(2) ?? "N/A"}× (${ms(repo.activeSessionMilliseconds)} / ${ms(repo.wallClockActiveMilliseconds)}; ${repo.sessions} sessions)`);
  }
  const i = w.interruptions;
  lines.push(
    `Interruptions: ${i.interrupted} interrupted, ${i.replaced} replaced, ${i.other} other; ${i.subagentInterrupted} sub-agent activity interruptions. Claude markers: ${count(i.claudeMarkers)} (P2 opt-in).`,
    `Interruptions per human turn: ${i.perHumanTurn?.toFixed(2) ?? "N/A"} (${i.eligibleHumanTurns} eligible turns in ${i.eligibleSessions} sessions; minimum 5 turns). Steering: ${w.steering.midTurnHumanTurns} mid-turn human inputs. Interrupts can rise with expertise; they are not a failure signal.`,
    `Planning: ${w.steering.planEntries} plan-mode entries; ${w.steering.planItems} Plan items. Queue: ${Object.entries(w.steering.queueOperations).map(([name, value]) => `${name} ${value}`).join(", ")}.`,
    `Archetypes (heuristic): ${Object.entries(w.archetypes).map(([name, value]) => `${name} ${value}`).join(", ")}.`,
    `Abandonment heuristic: ${w.abandonment.flagged}/${w.abandonment.eligible} eligible flagged; ${w.abandonment.ongoing} ongoing; ${w.abandonment.insufficientEvidence} insufficient evidence. An open turn inactive for 24h is a flag, not a verdict.`,
    `UTC active days: ${w.patterns.activeDays}; longest streak ${w.patterns.longestStreakDays}d; current ${w.patterns.currentStreakDays}d as of ${w.patterns.asOfDay}.`,
    `Hourly API-equivalent value: ${w.patterns.timestampedPricedRequests}/${w.patterns.pricedRequests} priced primary-transcript requests timestamped; not an invoice.`,
    `Slash commands: ${w.commands.slice(0, 12).map(({ name, count }) => `${name} ${count}`).join(", ") || "none observed"} (${w.commandHistorySessions} sessions with readable history).`,
    `Installed skills: ${w.installedSkills.length}; ${w.installedSkills.filter((s) => !s.observedInvocations).length} without an observed invocation in this scope (${w.inventory.directoriesRead} directories read; ${w.inventory.directoriesUnavailable} absent/unreadable). Codex usage is a lower bound.`,
    `CLI/model comparisons: ${w.comparisons.filter((c) => c.status === "eligible").length}/${w.comparisons.length} comparable transitions (same repository, provider, archetype, effort and entrypoint; minimum 5 sessions each side within 28d).`,
  );
  for (const change of w.comparisons.filter((c) => c.status === "eligible").slice(0, 6)) {
    lines.push(`  ${names.get(change.repositoryId) ?? "Repository"}: ${change.before} → ${change.after}, turn p50 ${ms(change.beforeTurnP50)} → ${ms(change.afterTurnP50)} (${change.beforeSessions}/${change.afterSessions} sessions).`);
  }
  for (const dimension of ["model", "effort", "cliVersion", "entrypoint", "originator"] as const) {
    const totals = new Map<string, number>();
    for (const item of w.mix.filter((item) => item.dimension === dimension)) {
      const key = `${item.provider}:${item.name}`; totals.set(key, (totals.get(key) ?? 0) + item.sessions);
    }
    lines.push(`${dimension} mix (observed session-days): ${[...totals].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, value]) => `${name} ${value}`).join(", ") || "unavailable"}.`);
  }
  const unused = w.installedSkills.filter((skill) => !skill.observedInvocations).slice(0, 12);
  if (unused.length) lines.push(`Skills without observed use in scope: ${unused.map((skill) => `${skill.provider}:${skill.name}`).join(", ")}.`);
  lines.push("Session lengths need a same-repository/task baseline. Version comparisons are descriptive; task difficulty is unknown. Activity does not prove success, quality or value delivered.\n");
  return `${lines.join("\n")}\n`;
}
