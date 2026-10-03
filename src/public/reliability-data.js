// Shared by the parser, terminal report and dashboard. No DOM or Node dependencies.
export const emptyLatency = () => ({ samples: 0, buckets: [], p50Ms: null, p95Ms: null });
export const emptyFlags = () => ({ exact_repeat: 0, repeated_failure: 0, failed_edit_cascade: 0, edit_thrash: 0, reread_churn: 0, search_loop: 0 });
export const emptyStats = () => ({ calls: 0, outcomes: { success: 0, error: 0, denied: 0, interrupted: 0, timeout: 0, unknown: 0 }, errors: {}, latency: emptyLatency() });
export const guardedShare = (numerator, denominator) => denominator >= 5 ? numerator / denominator : null;
export const errorDenominator = (stats) => stats.outcomes.success + stats.outcomes.error + stats.outcomes.timeout;
export const errorRate = (stats) => guardedShare(stats.outcomes.error + stats.outcomes.timeout, errorDenominator(stats));

function distribution(buckets) {
  const sorted = [...buckets].sort((a, b) => a[0] - b[0]);
  const samples = sorted.reduce((sum, [, count]) => sum + count, 0);
  function quantile(q) {
    if (!samples) return null;
    const rank = Math.ceil(samples * q);
    let count = 0;
    for (const [upper, n] of sorted) { count += n; if (count >= rank) return upper; }
    return null;
  }
  return { samples, buckets: sorted, p50Ms: quantile(0.5), p95Ms: quantile(0.95) };
}
export function latencyFrom(values) {
  const buckets = new Map();
  for (const value of values) {
    if (!Number.isFinite(value) || value < 0 || value > 604800000) continue;
    const upper = value === 0 ? 0 : Math.ceil(1.1 ** Math.ceil(Math.log(Math.max(1, value)) / Math.log(1.1)));
    buckets.set(upper, (buckets.get(upper) || 0) + 1);
  }
  return distribution(buckets);
}
export function mergeLatency(values) {
  const buckets = new Map();
  for (const value of values) for (const [upper, count] of value.buckets) buckets.set(upper, (buckets.get(upper) || 0) + count);
  return distribution(buckets);
}
function addCounts(target, source) {
  for (const key in source) {
    if (!Object.hasOwn(source, key) || key === "__proto__" || key === "constructor" || key === "prototype") continue;
    target[key] = (target[key] || 0) + source[key];
  }
}
function accumulator() { return { ...emptyStats(), buckets: new Map() }; }
function accumulate(target, value) {
  target.calls += value.calls;
  addCounts(target.outcomes, value.outcomes);
  addCounts(target.errors, value.errors);
  for (const [upper, count] of value.latency.buckets) target.buckets.set(upper, (target.buckets.get(upper) || 0) + count);
}
function finishStats(value) {
  return { calls: value.calls, outcomes: value.outcomes, errors: value.errors, latency: distribution(value.buckets) };
}
export function mergeStats(values) {
  const result = accumulator();
  for (const value of values) accumulate(result, value);
  return finishStats(result);
}
export function summarizeReliability(sessions) {
  const values = sessions.flatMap((s) => s.reliability ? [s.reliability] : []);
  const tools = new Map(), classes = new Map(), servers = new Map();
  const flags = emptyFlags();
  const permissions = { denials: 0, modes: {}, approvalPolicies: {}, sandboxes: {} };
  const verification = { checks: 0, passed: 0, failed: 0, editCalls: 0, share: null, skip: null, stepsToFirstEdit: null, msToFirstEdit: null, eligibleSessions: 0, skippedSessions: 0, firstEditSessions: 0, timedEditSessions: 0 };
  const apiErrors = {};
  let steps = 0, milliseconds = 0, timedEdits = 0;
  for (const value of values) {
    for (const tool of value.tools) {
      const key = `${tool.name}\0${tool.toolClass}`;
      let entry = tools.get(key);
      if (!entry) { entry = { name: tool.name, toolClass: tool.toolClass, stats: accumulator() }; tools.set(key, entry); }
      accumulate(entry.stats, tool);
    }
    for (const server of value.mcp) {
      let entry = servers.get(server.server);
      if (!entry) { entry = { connectionFailures: 0, stats: accumulator() }; servers.set(server.server, entry); }
      entry.connectionFailures += server.connectionFailures;
      accumulate(entry.stats, server);
    }
    if (value.flags) addCounts(flags, value.flags);
    permissions.denials += value.permissions.denials;
    for (const key of ["modes", "approvalPolicies", "sandboxes"]) addCounts(permissions[key], value.permissions[key]);
    addCounts(apiErrors, value.apiErrors);
    for (const key of ["checks", "passed", "failed", "editCalls"]) verification[key] += value.verification[key];
    if (value.verification.skip !== null) {
      verification.eligibleSessions += 1;
      verification.skippedSessions += Number(value.verification.skip);
    }
    if (value.verification.stepsToFirstEdit !== null) { verification.firstEditSessions += 1; steps += value.verification.stepsToFirstEdit; }
    if (value.verification.msToFirstEdit !== null) { timedEdits += 1; milliseconds += value.verification.msToFirstEdit; }
  }
  const toolRows = [...tools.values()].map((rows) => ({ name: rows.name, toolClass: rows.toolClass, ...finishStats(rows.stats) })).sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name) || a.toolClass.localeCompare(b.toolClass));
  // Tool groups already contain every observation; do not rebuild class histograms per session.
  for (const tool of toolRows) {
    let group = classes.get(tool.toolClass);
    if (!group) { group = accumulator(); classes.set(tool.toolClass, group); }
    accumulate(group, tool);
  }
  // Content rules must cover every supported session before making a pooled verification claim.
  if (values.length && values.every((v) => v.contentRules === "enabled" && !v.coverage.truncated && !v.coverage.unmatchedResults)) verification.share = guardedShare(verification.checks, verification.checks + verification.editCalls);
  verification.stepsToFirstEdit = verification.firstEditSessions ? steps / verification.firstEditSessions : null;
  verification.msToFirstEdit = timedEdits ? milliseconds / timedEdits : null;
  verification.timedEditSessions = timedEdits;
  return {
    sessions: sessions.length, coveredSessions: values.length,
    contentRuleSessions: values.filter((v) => v.contentRules === "enabled").length,
    flagSessions: values.filter((v) => v.flags !== null).length,
    truncatedSessions: values.filter((v) => v.coverage.truncated).length,
    tools: toolRows, totals: mergeStats(toolRows),
    classes: [...classes].map(([toolClass, rows]) => ({ toolClass, ...finishStats(rows) })).sort((a, b) => b.calls - a.calls || a.toolClass.localeCompare(b.toolClass)),
    mcp: [...servers].map(([server, rows]) => ({ server, connectionFailures: rows.connectionFailures, ...finishStats(rows.stats) })).sort((a, b) => b.calls - a.calls || a.server.localeCompare(b.server)),
    flags, permissions, verification, apiErrors,
    hooks: { runs: values.reduce((n, v) => n + v.hooks.runs, 0), blocks: values.reduce((n, v) => n + v.hooks.blocks, 0), latency: mergeLatency(values.map((v) => v.hooks.latency)) },
  };
}

// Comparisons need totals and eligibility only. Cache by immutable public projection;
// a refresh supplies new objects, and old snapshots can be garbage collected.
const sessionTotals = new WeakMap();
export function summarizeReliabilityComparisons(sessions) {
  const providers = new Map(), repositories = new Map();
  function group(map, key, name) {
    let value = map.get(key);
    if (!value) {
      value = { name, sessions: 0, coveredSessions: 0, stats: accumulator(), verification: { eligibleSessions: 0, skippedSessions: 0 } };
      map.set(key, value);
    }
    return value;
  }
  for (const session of sessions) {
    const groups = [group(providers, session.provider, session.provider), group(repositories, session.repositoryId, session.repositoryName)];
    const reliability = session.reliability;
    let totals = reliability && sessionTotals.get(reliability);
    if (reliability && !totals) { totals = mergeStats(reliability.tools); sessionTotals.set(reliability, totals); }
    for (const value of groups) {
      value.sessions += 1;
      if (!reliability) continue;
      value.coveredSessions += 1;
      accumulate(value.stats, totals);
      if (reliability.verification.skip !== null) {
        value.verification.eligibleSessions += 1;
        value.verification.skippedSessions += Number(reliability.verification.skip);
      }
    }
  }
  const finish = (map) => [...map.values()].map((v) => ({ name: v.name, sessions: v.sessions, coveredSessions: v.coveredSessions, totals: finishStats(v.stats), verification: v.verification }));
  return { providers: finish(providers), repositories: finish(repositories) };
}
