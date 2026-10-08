import { metricCoverage, metricEligible, providerIds, providerLabels } from "./providers.js";
import { daysBetween } from "./view-model.js";
import { localDay, shiftDay } from "./velocity-data.js";

const callCount = (value) => Number.isFinite(value) && value > 0 ? value : 0;
const startDay = (session) => session.transcript?.startTimeKnown === false || session.evidence?.timing === "file-mtime"
  ? null : localDay(session.createdAt, "UTC");
const change = (current, previous) => current === null || previous === null ? null
  : previous > 0 ? (current - previous) / previous : current > 0 ? "new" : 0;

/** The all-time chart shows at most the latest 366 calendar days; totals still cover the full selection. */
export function toolsDays(sessions) {
  let first = null, last = null;
  for (const session of sessions) {
    const day = startDay(session);
    if (!day) continue;
    if (first === null || day < first) first = day;
    if (last === null || day > last) last = day;
  }
  if (!last) return [];
  const cutoff = shiftDay(last, -365);
  return daysBetween(first < cutoff ? cutoff : first, last, 366);
}

function aggregate(sessions) {
  const coverage = metricCoverage(sessions, "tools"), tools = new Map();
  let total = 0;
  for (const session of sessions) {
    if (!metricEligible(session, "tools")) continue;
    for (const [name, value] of Object.entries(session.tools)) {
      const calls = callCount(value);
      if (!calls) continue;
      const tool = tools.get(name) ?? { name, calls: 0, sessions: 0, repositories: new Set() };
      tool.calls += calls;
      tool.sessions++;
      tool.repositories.add(session.repositoryId);
      total += calls;
      tools.set(name, tool);
    }
  }
  return { coverage, tools, totalCalls: coverage.eligible ? total : null };
}

/** Derived only from structured, effective tool names on eligible sessions. No session value is apportioned. */
export function buildToolsView(sessions, { previousSessions = null } = {}) {
  const current = aggregate(sessions);
  const previous = previousSessions === null ? null : aggregate(previousSessions);
  // An observed empty window is different from sessions with unavailable evidence.
  const comparable = previous !== null && (previous.coverage.eligible > 0 || previous.coverage.selected === 0);
  const previousCalls = comparable ? previous.totalCalls ?? 0 : null;
  const tools = [...current.tools.values()].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)).map((tool) => {
    const before = comparable ? previous.tools.get(tool.name)?.calls ?? 0 : null;
    return { name: tool.name, calls: tool.calls, share: tool.calls / current.totalCalls,
      sessions: tool.sessions, repositories: tool.repositories.size, previousCalls: before, change: change(tool.calls, before) };
  });
  return { coverage: current.coverage, totalCalls: current.totalCalls, eligibleSessions: current.coverage.eligible,
    distinctTools: current.coverage.eligible ? tools.length : null,
    callsPerSession: current.coverage.eligible ? current.totalCalls / current.coverage.eligible : null,
    previousCoverage: previous?.coverage ?? null, previousCalls, change: change(current.totalCalls, previousCalls), tools };
}

export function toolProfile(sessions, name, { days = toolsDays(sessions), repositoryNames = new Map() } = {}) {
  const coverage = metricCoverage(sessions, "tools");
  const byDay = new Map(days.map((day) => [day, { day, calls: 0, coverage: { eligible: 0, selected: 0 } }]));
  const providers = new Map(), repositories = new Map();
  let calls = 0, totalCalls = 0, using = 0, undatedCalls = 0, outsideDaysCalls = 0;
  for (const session of sessions) {
    const day = startDay(session), row = byDay.get(day), eligible = metricEligible(session, "tools");
    if (row) { row.coverage.selected++; if (eligible) row.coverage.eligible++; }
    if (!eligible) continue;
    totalCalls += Object.values(session.tools).reduce((sum, value) => sum + callCount(value), 0);
    const count = Object.hasOwn(session.tools, name) ? callCount(session.tools[name]) : 0;
    if (!count) continue;
    calls += count; using++;
    if (row) row.calls += count;
    else if (day === null) undatedCalls += count;
    else outsideDaysCalls += count;
    providers.set(session.provider, (providers.get(session.provider) ?? 0) + count);
    const repository = repositories.get(session.repositoryId) ?? { id: session.repositoryId,
      name: repositoryNames.get(session.repositoryId) ?? session.repositoryName, calls: 0 };
    repository.calls += count;
    repositories.set(session.repositoryId, repository);
  }
  return { name, coverage, calls: coverage.eligible ? calls : null, share: totalCalls ? calls / totalCalls : null,
    sessions: coverage.eligible ? using : null, repositories: coverage.eligible ? repositories.size : null,
    callsPerSession: using ? calls / using : null, byDay: [...byDay.values()], undatedCalls, outsideDaysCalls,
    byProvider: providerIds.filter((provider) => providers.has(provider)).map((provider) => ({ provider,
      label: providerLabels[provider], calls: providers.get(provider), share: providers.get(provider) / calls })),
    byRepository: [...repositories.values()].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name))
      .map((repository) => ({ id: repository.id, name: repository.name, calls: repository.calls, share: repository.calls / calls })) };
}
