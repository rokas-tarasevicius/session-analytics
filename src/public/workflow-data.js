// Pure, content-free calculations shared by the analysis worker and the browser.
// Keep this module free of DOM, Node APIs, and provider records.
const HOUR = 3_600_000, DAY = 24 * HOUR;
const iso = (time) => new Date(time).toISOString();
const day = (time) => iso(time).slice(0, 10);
const sum = (values) => values.reduce((total, value) => total + value, 0);
const add = (map, key, count = 1) => map.set(key, (map.get(key) || 0) + count);

function fromBins(counts) {
  const bins = [...counts].filter(([value, count]) => Number.isFinite(value) && value >= 0 && count > 0)
    .sort(([a], [b]) => a - b).map(([value, count]) => ({ value, count }));
  const samples = sum(bins.map(({ count }) => count));
  const percentile = (p) => {
    if (!samples) return null;
    const rank = Math.max(1, Math.ceil(p * samples));
    let seen = 0;
    for (const bin of bins) { seen += bin.count; if (seen >= rank) return bin.value; }
    return null;
  };
  return { bins, samples, p50: percentile(.5), p95: percentile(.95), max: bins.at(-1)?.value ?? null };
}

export function histogram(values) {
  const counts = new Map();
  for (const value of values) add(counts, value);
  return fromBins(counts);
}

export function mergeHistograms(histograms) {
  const counts = new Map();
  for (const histogram of histograms) for (const { value, count } of histogram.bins) add(counts, value, count);
  return fromBins(counts);
}

function mergedSpans(spans) {
  const sorted = spans.map(({ start, end }) => [Date.parse(start), Date.parse(end)])
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort(([a], [b]) => a - b);
  const merged = [];
  for (const [start, end] of sorted) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

// Half-open intervals: an ending session never overlaps one starting at that instant.
export function concurrency(sessions) {
  const deltas = new Map();
  let eligibleSessions = 0;
  for (const { spans } of sessions) {
    const merged = mergedSpans(spans);
    if (merged.length) eligibleSessions += 1;
    for (const [start, end] of merged) { add(deltas, start, 1); add(deltas, end, -1); }
  }
  const timeline = [], days = new Map();
  let active = 0, previous = null, peak = 0, activeSessionMilliseconds = 0, wallClockActiveMilliseconds = 0;
  for (const [at, delta] of [...deltas].sort(([a], [b]) => a - b)) {
    if (previous !== null && at > previous && active > 0) {
      const last = timeline.at(-1);
      if (last && last.sessions === active && last.end === iso(previous)) last.end = iso(at);
      else timeline.push({ start: iso(previous), end: iso(at), sessions: active });
      peak = Math.max(peak, active);
      activeSessionMilliseconds += (at - previous) * active;
      wallClockActiveMilliseconds += at - previous;
      for (let start = previous; start < at;) {
        const end = Math.min(at, (Math.floor(start / DAY) + 1) * DAY), key = day(start);
        const daily = days.get(key) || { day: key, peak: 0, activeSessionMilliseconds: 0, wallClockActiveMilliseconds: 0 };
        daily.peak = Math.max(daily.peak, active);
        daily.activeSessionMilliseconds += (end - start) * active;
        daily.wallClockActiveMilliseconds += end - start;
        days.set(key, daily); start = end;
      }
    }
    active += delta; previous = at;
  }
  return {
    peak, activeSessionMilliseconds, wallClockActiveMilliseconds, eligibleSessions,
    effectiveParallelism: wallClockActiveMilliseconds >= 60_000 ? activeSessionMilliseconds / wallClockActiveMilliseconds : null,
    timeline, daily: [...days.values()],
  };
}

// A same-repository comparison controls for observable workflow shape. It cannot
// control task difficulty or establish that a model/CLI change caused a shift.
export function compareVersions(sessions) {
  const results = [];
  for (const dimension of ["cliVersion", "model"]) {
    const groups = new Map();
    for (const session of sessions) {
      const w = session.workflow;
      if (!w || w.humanTurns === null || !w.archetype || w.coverage.timing !== "observed" || !w.turnWallTime.samples || w.ending !== "terminal" || session.transcript.snapshotWhileWorking) continue;
      if (!Number.isFinite(Date.parse(session.createdAt))) continue;
      const fields = ["model", "cliVersion", "effort", "entrypoint"];
      if (fields.some((field) => {
        const firstKnown = w.mix.findIndex((m) => m[field] !== null && m[field] !== "unknown");
        return firstKnown < 0 || w.mix.slice(firstKnown).some((m) => m[field] === null || m[field] === "unknown");
      })) continue;
      const stable = Object.fromEntries(fields.map((field) => [field, [...new Set(w.mix.map((sample) => sample[field]).filter((value) => value !== null))]]));
      if (fields.some((field) => stable[field].length !== 1)) continue;
      const value = stable[dimension][0], constant = stable[dimension === "model" ? "cliVersion" : "model"][0];
      const effort = stable.effort[0], entrypoint = stable.entrypoint[0];
      if (entrypoint === "unknown") continue;
      const durationEvidence = w.recordedTurnDurations === w.turnWallTime.samples ? "provider-duration" : w.inferredTurnDurations === w.turnWallTime.samples ? "event-derived" : "mixed";
      const key = JSON.stringify([session.repositoryId, session.provider, w.archetype, effort, entrypoint, constant, durationEvidence]);
      const group = groups.get(key) || { repositoryId: session.repositoryId, provider: session.provider, dimension, archetype: w.archetype, effort, entrypoint, heldConstant: constant, durationEvidence, versions: new Map() };
      const cohort = group.versions.get(value) || [];
      cohort.push(session); group.versions.set(value, cohort); groups.set(key, group);
    }
    for (const group of groups.values()) {
      const cohorts = [...group.versions].map(([name, sessions]) => ({ name, sessions: sessions.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)) }))
        .sort((a, b) => Date.parse(a.sessions[0].createdAt) - Date.parse(b.sessions[0].createdAt));
      // Adjacent observed eras; a model used intermittently is explicitly ineligible.
      for (let index = 1; index < cohorts.length; index += 1) {
        const before = cohorts[index - 1], after = cohorts[index];
        const changedAt = iso(Date.parse(after.sessions[0].createdAt));
        const boundary = Date.parse(changedAt);
        const left = before.sessions.filter((s) => Date.parse(s.createdAt) >= boundary - 28 * DAY && Date.parse(s.createdAt) < boundary);
        const right = after.sessions.filter((s) => Date.parse(s.createdAt) <= boundary + 28 * DAY);
        const overlaps = Date.parse(before.sessions.at(-1).createdAt) >= boundary;
        const status = overlaps ? "overlapping-eras" : left.length < 5 || right.length < 5 ? "small-cohort" : "eligible";
        const p50 = (cohort, field) => mergeHistograms(cohort.map((s) => s.workflow[field])).p50;
        const beforeTurnP50 = p50(left, "turnWallTime"), afterTurnP50 = p50(right, "turnWallTime");
        results.push({
          repositoryId: group.repositoryId, provider: group.provider, dimension, archetype: group.archetype,
          effort: group.effort, entrypoint: group.entrypoint, heldConstant: group.heldConstant,
          durationEvidence: group.durationEvidence,
          before: before.name, after: after.name, changedAt, beforeSessions: left.length, afterSessions: right.length, status,
          beforeTurnP50, afterTurnP50, beforeRunP50: p50(left, "toolRuns"), afterRunP50: p50(right, "toolRuns"),
          turnTimeChange: status === "eligible" && beforeTurnP50 >= 1000 && afterTurnP50 !== null ? afterTurnP50 / beforeTurnP50 - 1 : null,
        });
      }
    }
  }
  return results.sort((a, b) => b.changedAt.localeCompare(a.changedAt));
}

function patterns(workflows, asOf) {
  const cells = Array.from({ length: 168 }, (_, index) => ({ weekday: Math.floor(index / 24), hour: index % 24, activeMilliseconds: 0, apiEquivalentUsd: 0 }));
  const activeDays = new Set();
  for (const w of workflows) {
    for (const { start: rawStart, end: rawEnd } of w.time.activeSpans) {
      const end = Date.parse(rawEnd);
      for (let start = Date.parse(rawStart); start < end;) {
        const next = Math.min(end, (Math.floor(start / HOUR) + 1) * HOUR), date = new Date(start);
        cells[date.getUTCDay() * 24 + date.getUTCHours()].activeMilliseconds += next - start;
        activeDays.add(day(start)); start = next;
      }
    }
    for (const { hour, usd } of w.valueByHour) {
      const date = new Date(hour);
      cells[date.getUTCDay() * 24 + date.getUTCHours()].apiEquivalentUsd += usd;
    }
  }
  const dates = [...activeDays].sort();
  let longest = 0, current = 0, previous = -Infinity;
  for (const date of dates) {
    const time = Date.parse(date);
    current = time - previous === DAY ? current + 1 : 1;
    longest = Math.max(longest, current); previous = time;
  }
  const asOfDay = day(Number.isFinite(Date.parse(asOf)) ? Date.parse(asOf) : Date.now());
  let currentStreakDays = 0, cursor = Date.parse(asOfDay);
  if (!activeDays.has(day(cursor))) cursor -= DAY;
  while (activeDays.has(day(cursor))) { currentStreakDays += 1; cursor -= DAY; }
  return { timezone: "UTC", cells, activeDays: dates.length, longestStreakDays: longest, currentStreakDays, asOfDay,
    pricedRequests: sum(workflows.map((w) => w.pricedRequests)), timestampedPricedRequests: sum(workflows.map((w) => w.timestampedPricedRequests)) };
}

export function summarizeWorkflow(sessions, inventory, asOf = new Date().toISOString()) {
  const supported = sessions.filter((s) => s.workflow && s.transcript.status === "ok");
  const workflows = supported.map((s) => s.workflow), human = workflows.filter((w) => w.humanTurns !== null);
  const humanTurns = sum(human.map((w) => w.humanTurns));
  const interruptions = { interrupted: 0, replaced: 0, other: 0, subagentInterrupted: 0, claudeMarkers: null };
  const steering = { midTurnHumanTurns: 0, planEntries: 0, planItems: 0, queueOperations: { enqueue: 0, dequeue: 0, remove: 0, other: 0 }, queueReasons: { prompt: 0, interrupt: 0, completion: 0, cancellation: 0, other: 0, unspecified: 0 } };
  const archetypes = { quick: 0, standard: 0, deep: 0, marathon: 0, unavailable: 0 };
  const abandonment = { flagged: 0, eligible: 0, ongoing: 0, insufficientEvidence: 0 };
  const commands = new Map(), mix = new Map();
  let eligibleHumanTurns = 0, interruptNumerator = 0, eligibleSessions = 0;
  for (const s of supported) {
    const w = s.workflow;
    for (const key of ["interrupted", "replaced", "other", "subagentInterrupted"]) interruptions[key] += w.interruptions[key];
    if (w.interruptions.claudeMarkers !== null) interruptions.claudeMarkers = (interruptions.claudeMarkers ?? 0) + w.interruptions.claudeMarkers;
    if (w.humanTurns !== null && (s.provider === "codex" || w.coverage.contentRules)) {
      eligibleSessions += 1; eligibleHumanTurns += w.humanTurns;
      interruptNumerator += w.interruptions.interrupted + w.interruptions.replaced + w.interruptions.other + (w.interruptions.claudeMarkers ?? 0);
    }
    for (const key of ["midTurnHumanTurns", "planEntries", "planItems"]) steering[key] += w.steering[key];
    for (const key of Object.keys(steering.queueOperations)) steering.queueOperations[key] += w.steering.queueOperations[key];
    for (const key of Object.keys(steering.queueReasons)) steering.queueReasons[key] += w.steering.queueReasons[key];
    archetypes[w.archetype ?? "unavailable"] += 1;
    if (w.abandonment === "flagged" || w.abandonment === "not-flagged") abandonment.eligible += 1;
    if (w.abandonment === "flagged") abandonment.flagged += 1;
    if (w.abandonment === "ongoing") abandonment.ongoing += 1;
    if (w.abandonment === "insufficient-evidence") abandonment.insufficientEvidence += 1;
    for (const { name } of w.commands) add(commands, name);
    const seen = new Set();
    for (const sample of w.mix) for (const dimension of ["model", "effort", "cliVersion", "entrypoint", "originator"]) {
      const name = sample[dimension];
      if (!name || name === "unknown") continue;
      const key = JSON.stringify([sample.at.slice(0, 10), s.provider, dimension, name]);
      if (!seen.has(key)) { add(mix, key); seen.add(key); }
    }
  }
  const repositoryIds = [...new Set(sessions.map((s) => s.repositoryId))];
  const repositories = repositoryIds.map((repositoryId) => {
    const selected = supported.filter((s) => s.repositoryId === repositoryId);
    const c = concurrency(selected.map((s) => ({ spans: s.workflow.time.activeSpans })));
    return { repositoryId, sessions: selected.length, peak: c.peak, effectiveParallelism: c.effectiveParallelism,
      activeSessionMilliseconds: c.activeSessionMilliseconds, wallClockActiveMilliseconds: c.wallClockActiveMilliseconds };
  });
  return {
    schemaVersion: 1,
    coverage: { sessions: sessions.length, supportedSessions: workflows.length, timedSessions: workflows.filter((w) => w.coverage.timing !== "unavailable").length,
      humanSessions: human.length, contentRuleSessions: workflows.filter((w) => w.coverage.contentRules).length, partialSessions: workflows.filter((w) => w.coverage.timing === "partial").length },
    autonomy: { humanTurns, turnsPerSession: human.length >= 5 ? humanTurns / human.length : null,
      toolRuns: mergeHistograms(human.map((w) => w.toolRuns)), turnWallTime: mergeHistograms(workflows.map((w) => w.turnWallTime)),
      recordedTurnDurations: sum(workflows.map((w) => w.recordedTurnDurations)), inferredTurnDurations: sum(workflows.map((w) => w.inferredTurnDurations)) },
    time: { activeMilliseconds: sum(workflows.map((w) => w.time.activeMilliseconds)), waitingForHumanMilliseconds: sum(workflows.map((w) => w.time.waitingForHumanMilliseconds)), unclassifiedMilliseconds: sum(workflows.map((w) => w.time.unclassifiedMilliseconds)) },
    interruptions: { ...interruptions, eligibleHumanTurns, eligibleSessions, perHumanTurn: eligibleHumanTurns >= 5 ? interruptNumerator / eligibleHumanTurns : null },
    steering, concurrency: concurrency(workflows.map((w) => ({ spans: w.time.activeSpans }))), repositories, archetypes, abandonment,
    patterns: patterns(workflows, asOf),
    mix: [...mix].map(([key, sessions]) => { const [day, provider, dimension, name] = JSON.parse(key); return { day, provider, dimension, name, sessions }; }).sort((a, b) => a.day.localeCompare(b.day)),
    comparisons: compareVersions(supported),
    commands: [...commands].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    commandHistorySessions: workflows.filter((w) => w.commandHistoryAvailable).length,
    installedSkills: (inventory?.skills || []).filter((skill) => skill.repositoryId === null || repositoryIds.includes(skill.repositoryId)).map((skill) => ({
      name: skill.name, provider: skill.provider, repositoryId: skill.repositoryId,
      observedInvocations: sum(sessions.filter((s) => s.provider === skill.provider && (skill.repositoryId === null || skill.repositoryId === s.repositoryId)).map((s) => s.skills[skill.name] || 0)),
    })),
    inventory: { directoriesRead: inventory?.directoriesRead ?? 0, directoriesUnavailable: inventory?.directoriesUnavailable ?? 0, historyFilesRead: inventory?.historyFilesRead ?? 0, historyFilesUnavailable: inventory?.historyFilesUnavailable ?? 0, malformedHistoryRecords: inventory?.malformedHistoryRecords ?? 0 },
  };
}
