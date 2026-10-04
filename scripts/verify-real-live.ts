/** Independent session-to-aggregate proof for exact, source-identified live changes.
 * No production accounting imports. Unproved namespaces remain byte-for-byte inputs.
 */
import { createHash } from 'node:crypto';
type Row = Record<string, any>;
const tokens = ['inputTokens', 'uncachedInputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'cacheWrite5mInputTokens', 'cacheWrite1hInputTokens', 'outputTokens', 'reasoningOutputTokens', 'nonReasoningOutputTokens'];
const money = ['inputUsd', 'cachedInputUsd', 'cacheWriteUsd', 'outputUsd', 'totalUsd', 'upperEstimateUsd'];
const finite = (value: unknown): number => { if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Unavailable live proof operand.'); return value; };
const array = (value: unknown): Row[] => { if (!Array.isArray(value)) throw new Error('Unavailable live proof rows.'); return value; };
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-7 + Math.max(Math.abs(a), Math.abs(b)) * 1e-12;
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function same(a: any, b: any, field = ''): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return /Usd$/.test(field) ? close(a, b) : /Ratio$|Coverage$/.test(field) && Math.abs(a - b) <= 1e-12;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a).sort();
  return JSON.stringify(keys) === JSON.stringify(Object.keys(b).sort()) && keys.every(key => same(a[key], b[key], field === 'linesPerApiDollar' && ['value', 'denominator'].includes(key) ? 'totalUsd' : field === 'apiEquivalentPerMergedPr' && ['value', 'numerator'].includes(key) ? 'totalUsd' : field === 'commitSessionRate' && key === 'value' ? 'cacheReadRatio' : key));
}
const sum = (rows: Row[], get: (row: Row) => unknown) => rows.reduce((n, row) => n + finite(get(row)), 0);
function summary(rows: Row[]): Row {
  const input = sum(rows, s => s.tokens.inputTokens);
  const coverageRows = rows.filter(s => s.pricedTokenCoverage !== null);
  const eligible = sum(coverageRows, s => finite(s.tokens.inputTokens) + finite(s.tokens.outputTokens));
  const priced = sum(coverageRows, s => sum(array(s.models), m => m.pricingCoverage ? m.pricingCoverage.pricedTokens : m.priced ? finite(m.inputTokens) + finite(m.outputTokens) : 0));
  return {
    sessions: rows.length, analyzedSessions: rows.filter(s => s.transcript.status === 'ok').length,
    missingTranscripts: rows.filter(s => s.transcript.status === 'missing').length,
    estimatedSpendUsd: sum(rows, s => s.cost.totalUsd), estimatedUpperSpendUsd: sum(rows, s => s.cost.upperEstimateUsd),
    apiEquivalentSpendUsd: sum(rows.filter(s => s.costBasis === 'api-list-price-equivalent'), s => s.cost.totalUsd),
    providerReportedSpendUsd: sum(rows.filter(s => s.costBasis === 'provider-reported'), s => s.cost.totalUsd),
    totalInputTokens: input, outputTokens: sum(rows, s => s.tokens.outputTokens),
    cacheReadRatio: input ? sum(rows, s => s.tokens.cachedInputTokens) / input : null,
    pricedTokenCoverage: eligible ? priced / eligible : null,
    compactions: sum(rows, s => s.metrics.compactions), toolCalls: sum(rows, s => s.metrics.toolCalls),
    topLevelSessions: rows.filter(s => ['top-level', 'mixed'].includes(s.executionKind)).length,
    subagentSessions: rows.filter(s => ['subagent', 'mixed'].includes(s.executionKind)).length,
    topLevelSpendUsd: sum(rows, s => s.costByExecution.topLevelUsd), subagentSpendUsd: sum(rows, s => s.costByExecution.subagentUsd),
    unpricedSessions: rows.filter(s => s.pricedTokenCoverage !== null && s.pricedTokenCoverage < 1 && finite(s.tokens.inputTokens) + finite(s.tokens.outputTokens) > 0).length,
  };
}
function named(rows: Row[], field: 'spendByDay' | 'tools'): Row[] {
  const totals = new Map<string, number>();
  for (const row of rows) for (const [key, value] of Object.entries(row[field])) totals.set(key, (totals.get(key) ?? 0) + finite(value));
  return [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => ({ name, value }));
}
function models(rows: Row[]): Row[] {
  const grouped = new Map<string, Row[]>();
  for (const s of rows) for (const m of array(s.models)) { const group = grouped.get(m.model) ?? []; group.push(m); grouped.set(m.model, group); }
  return [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([model, members]) => {
    const result: Row = { model, priced: members.every(m => m.priced === true) };
    for (const field of [...tokens, ...money, 'calls']) result[field] = sum(members, m => m[field]);
    if (members.some(m => m.pricingCoverage !== undefined)) result.pricingCoverage = Object.fromEntries(['pricedTokens', 'eligibleTokens'].map(field => [field, sum(members.filter(m => m.pricingCoverage !== undefined), m => m.pricingCoverage[field])]));
    if (members.some(m => m.pricing !== undefined)) result.pricing = [...new Set(members.flatMap(m => m.pricing ?? []).map(p => JSON.stringify(canonical(p))))].sort().map(p => JSON.parse(p));
    return result;
  });
}
function table(rows: unknown, key: 'name' | 'model', dollarValue: boolean): Row[] {
  const values = array(rows);
  if (new Set(values.map(row => row[key])).size !== values.length) throw new Error('Duplicate aggregate identity.');
  return values.map(row => {
    const result = { ...row };
    if (key === 'model' && result.pricing !== undefined) result.pricing = array(result.pricing).map(p => JSON.stringify(canonical(p))).sort().map(p => JSON.parse(p));
    if (dollarValue) { result['totalUsd'] = result['value']; delete result['value']; }
    return result;
  }).sort((a, b) => String(a[key]).localeCompare(String(b[key])));
}
/** Counts, artifact unions and ratio operands from the public outcome contract. */
function outcomeSummary(sessions: Row[]): Row {
  const observed = sessions.filter(s => s.outcomes), api = observed.filter(s => s.costBasis === 'api-list-price-equivalent');
  const links = (s: Row, kind: string) => array(s.outcomes.links).filter(l => l.role === 'outcome' && l.kind === kind);
  const commit = (s: Row) => finite(s.outcomes.operations.commits) > 0 || links(s, 'commit').length > 0;
  const priced = (s: Row) => s.costComplete === true && s.pricedTokenCoverage === 1;
  const measured = (s: Row) => s.outcomes.linesAdded !== null && s.outcomes.linesRemoved !== null;
  const artifacts = observed.flatMap(s => links(s, 'pull-request')).filter(l => l.identity === 'artifact');
  const allRefs = new Set(artifacts.map(l => l.ref)), mergedRefs = new Set(artifacts.filter(l => l.state === 'merged').map(l => l.ref));
  const lineCandidates = api.filter(measured), lineEligible = lineCandidates.filter(s => priced(s) && finite(s.cost.totalUsd) > 0 && s.outcomes.lineCoverage === 'complete');
  const unlinked = api.filter(s => s.outcomes.editsObserved && !commit(s));
  const mergeRows = api.map(s => {
    const refs = [...new Set(links(s, 'pull-request').filter(l => l.identity === 'artifact').map(l => l.ref))];
    return { s, refs, merged: refs.filter(ref => mergedRefs.has(ref)), complete: s.outcomes.prAssociationsComplete ?? !s.outcomes.truncated };
  }).filter(r => r.merged.length || !r.complete);
  const mergeEligible = mergeRows.filter(r => r.complete && priced(r.s));
  const ratio = (numerator: number, denominator: number, eligible: number, candidates: number, minimum: number, minSessions = 1, incomplete = false, missing = 0) => {
    const status = missing ? 'incomplete-evidence' : !denominator || !candidates ? 'unavailable' : incomplete ? 'incomplete-pricing' : denominator < minimum || eligible < minSessions ? 'insufficient-activity' : 'available';
    return { numerator, denominator, value: status === 'available' ? numerator / denominator : null, eligibleSessions: eligible,
      candidateSessions: candidates, minimumDenominator: minimum, minimumSessions: minSessions, incompleteEvidenceSessions: missing, status };
  };
  const commits = observed.filter(commit).length;
  return {
    sessions: sessions.length, observedSessions: observed.length, editSessions: observed.filter(s => s.outcomes.editsObserved).length,
    commitSessions: commits, prSessions: observed.filter(s => links(s, 'pull-request').length).length,
    mergedPrSessions: observed.filter(s => links(s, 'pull-request').some(l => l.state === 'merged' || mergedRefs.has(l.ref))).length,
    contextOnlySessions: observed.filter(s => !commit(s) && !links(s, 'pull-request').length && array(s.outcomes.links).length > 0 && s.outcomes.links.every((l: Row) => l.role === 'context')).length,
    lineMeasuredSessions: observed.filter(measured).length,
    coverage: { lines: Object.fromEntries(['complete', 'partial', 'unavailable'].map(state => [state, observed.filter(s => s.outcomes.lineCoverage === state).length])),
      truncatedSessions: observed.filter(s => s.outcomes.truncated).length,
      enrichment: Object.fromEntries(['git', 'github'].map(kind => [kind, Object.fromEntries(['off', 'not-applicable', 'matched', 'no-match', 'unavailable', 'limited'].map(status => [status, observed.filter(s => s.outcomes.enrichment[kind] === status).length]))])) },
    linesAdded: sum(observed.filter(measured), s => s.outcomes.linesAdded), linesRemoved: sum(observed.filter(measured), s => s.outcomes.linesRemoved),
    apiSessions: api.length, apiPricedSessions: api.filter(priced).length, apiEquivalentValueUsd: sum(api, s => s.cost.totalUsd),
    unlinkedApiEquivalentUsd: sum(unlinked, s => s.cost.totalUsd), unlinkedEditSessions: unlinked.length,
    pullRequests: { linked: allRefs.size, created: new Set(artifacts.filter(l => l.created).map(l => l.ref)).size, merged: mergedRefs.size,
      unidentifiedCreatedOperations: observed.flatMap(s => links(s, 'pull-request')).filter(l => l.identity === 'observation' && l.created).length,
      unidentifiedMergedOperations: observed.flatMap(s => links(s, 'pull-request')).filter(l => l.identity === 'observation' && l.state === 'merged').length },
    operations: Object.fromEntries(['commits', 'pushes', 'prsCreated', 'prsEdited', 'prsMerged', 'prsClosed'].map(field => [field, sum(observed, s => s.outcomes.operations[field])])),
    commitSessionRate: ratio(commits, observed.length, observed.length, sessions.length, 5),
    linesPerApiDollar: ratio(sum(lineEligible, s => finite(s.outcomes.linesAdded) + finite(s.outcomes.linesRemoved)), sum(lineEligible, s => s.cost.totalUsd), lineEligible.length, lineCandidates.length, 1, 5),
    apiEquivalentPerMergedPr: ratio(sum(mergeEligible, r => finite(r.s.cost.totalUsd) * r.merged.length / r.refs.length), new Set(mergeRows.flatMap(r => r.merged)).size, mergeEligible.length, mergeRows.length, 3, 1, mergeRows.some(r => !priced(r.s)), mergeRows.filter(r => !r.complete).length),
  };
}
function historySessionValues(rows: Row[], knownProfiles: Set<string>) {
  const months = new Map<string, Row>();
  const month = (key: string) => { let value = months.get(key); if (!value) { value = { sessionEvidenceUsd: 0, sessionsWithDatedValue: 0, recoveredMessageUsd: 0 }; months.set(key, value); } return value; };
  let undatedSessionValueUsd = 0, unassignedProfileTokens = 0;
  for (const s of rows) {
    const datedMonths = new Set<string>(); let dated = 0;
    for (const [day, raw] of Object.entries(s.spendByDay)) {
      if (!/^\d{4}-\d\d-\d\d$/.test(day) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) throw new Error('Invalid day operand.');
      const value = finite(raw); month(day.slice(0, 7)).sessionEvidenceUsd += value; dated += value; datedMonths.add(day.slice(0, 7));
    }
    for (const key of datedMonths) month(key).sessionsWithDatedValue++;
    undatedSessionValueUsd += Math.max(0, finite(s.cost.totalUsd) - dated);
    if (s.provider === 'claude' && s.history && !knownProfiles.has(s.limitsCache?.profileKey)) {
      for (const bucket of array(s.history.days)) { unassignedProfileTokens += finite(bucket.tokens); month(bucket.day.slice(0, 7)).recoveredMessageUsd += finite(bucket.valueUsd); }
      unassignedProfileTokens += finite(s.history.undatedTokens);
    }
  }
  return { months, undatedSessionValueUsd, unassignedProfileTokens };
}
export type LiveAggregateProof = { scope: string; field: string; before?: number | null; after?: number | null; changedBefore?: number | null; changedAfter?: number | null };

/** Returns comparison copies with only independently proved live contributions removed. */
export function proveLiveAggregates(before: Row, after: Row, excluded: ReadonlySet<string>) {
  const copy = (snapshot: Row): Row & { repositories: Row[] } => ({ ...snapshot, summary: { ...snapshot.summary }, repositories: array(snapshot.repositories).map(r => ({ ...r, summary: { ...r.summary } })) });
  const left = copy(before), right = copy(after), accepted: LiveAggregateProof[] = [], failures: string[] = [];
  const prove = (a: Row, b: Row, oldRows: Row[], newRows: Row[], scope: string, machine: boolean) => {
    const stableOld = oldRows.filter(s => !excluded.has(s.sessionKey)), stableNew = newRows.filter(s => !excluded.has(s.sessionKey));
    const changedOld = oldRows.filter(s => excluded.has(s.sessionKey)), changedNew = newRows.filter(s => excluded.has(s.sessionKey));
    try {
      const oldExpected = summary(oldRows), newExpected = summary(newRows), stableA = summary(stableOld), stableB = summary(stableNew);
      const changedA = summary(changedOld), changedB = summary(changedNew);
      if (machine) for (const [actual, all, stable, changed] of [[oldExpected, oldRows, stableA, changedA], [newExpected, newRows, stableB, changedB]] as const) {
        const working = (ss: Row[]) => ss.filter(s => s.transcript.snapshotWhileWorking && !s.transcript.sourceDeleted && !s.transcript.warnings.includes('Source availability could not be checked; showing the last indexed facts.')).length;
        actual.workingSnapshots = working(all); stable.workingSnapshots = working(all === oldRows ? stableOld : stableNew); changed.workingSnapshots = working(all === oldRows ? changedOld : changedNew);
      }
      for (const field of Object.keys(oldExpected)) {
        if (!same(a.summary[field], oldExpected[field], field) || !same(b.summary[field], newExpected[field], field) || !same(stableA[field], stableB[field], field)) { failures.push(`${scope}.summary.${field}`); continue; }
        if (!same(a.summary[field], b.summary[field], field)) accepted.push({ scope, field: `summary.${field}`, before: a.summary[field], after: b.summary[field], changedBefore: changedA[field], changedAfter: changedB[field] });
        a.summary[field] = stableA[field]; b.summary[field] = stableA[field];
      }
      for (const field of ['spendByDay', 'topTools', 'spendByModel'] as const) {
        const isModel = field === 'spendByModel', isDay = field === 'spendByDay';
        const derive = (rows: Row[]) => isModel ? models(rows) : named(rows, isDay ? 'spendByDay' : 'tools');
        const normalize = (value: Row[]) => table(value, isModel ? 'model' : 'name', isDay);
        const stable = normalize(derive(stableOld));
        if (!same(normalize(a[field]), normalize(derive(oldRows))) || !same(normalize(b[field]), normalize(derive(newRows))) || !same(stable, normalize(derive(stableNew)))) { failures.push(`${scope}.${field}`); continue; }
        // Preserve documented ranking checks before replacing live-dependent order.
        const ordered = (value: Row[]) => value.every((row, i) => i === 0 || (isDay ? String(value[i - 1]!.name) <= String(row.name) : finite(value[i - 1]![isModel ? 'totalUsd' : 'value']) >= finite(row[isModel ? 'totalUsd' : 'value'])));
        if (!ordered(a[field]) || !ordered(b[field])) { failures.push(`${scope}.${field}.order`); continue; }
        if (!same(normalize(a[field]), normalize(b[field]))) accepted.push({ scope, field });
        a[field] = stable; b[field] = stable;
      }
      if (a.outcomes !== undefined || b.outcomes !== undefined) {
        const oldOutcomes = outcomeSummary(oldRows), newOutcomes = outcomeSummary(newRows), stable = outcomeSummary(stableOld);
        if (!same(a.outcomes, oldOutcomes) || !same(b.outcomes, newOutcomes) || !same(stable, outcomeSummary(stableNew))) failures.push(`${scope}.outcomes`);
        else { if (!same(a.outcomes, b.outcomes)) accepted.push({ scope, field: 'outcomes' }); a.outcomes = stable; b.outcomes = stable; }
      }
    } catch { failures.push(`${scope}.unavailable`); }
  };
  prove(left, right, array(before.sessions), array(after.sessions), 'machine', true);
  if (before.historyCoverage && after.historyCoverage) {
    left.historyCoverage = { ...before.historyCoverage, months: array(before.historyCoverage.months).map(row => ({ ...row })) };
    right.historyCoverage = { ...after.historyCoverage, months: array(after.historyCoverage.months).map(row => ({ ...row })) };
    try {
      const profilesA = new Set<string>(array(before.historyCoverage.profiles).map(p => p.profileKey)), profilesB = new Set<string>(array(after.historyCoverage.profiles).map(p => p.profileKey));
      const stableA = array(before.sessions).filter(s => !excluded.has(s.sessionKey)), stableB = array(after.sessions).filter(s => !excluded.has(s.sessionKey));
      const oldExpected = historySessionValues(array(before.sessions), profilesA), newExpected = historySessionValues(array(after.sessions), profilesB);
      const oldStable = historySessionValues(stableA, profilesA), newStable = historySessionValues(stableB, profilesB);
      for (const field of ['undatedSessionValueUsd', 'unassignedProfileTokens'] as const) {
        if (!same(left.historyCoverage[field], oldExpected[field], field) || !same(right.historyCoverage[field], newExpected[field], field) || !same(oldStable[field], newStable[field], field)) failures.push(`historyCoverage.${field}`);
        else { if (!same(left.historyCoverage[field], right.historyCoverage[field], field)) accepted.push({ scope: 'historyCoverage', field }); left.historyCoverage[field] = oldStable[field]; right.historyCoverage[field] = oldStable[field]; }
      }
      const otherMonths = new Map(array(right.historyCoverage.months).map(row => [row.month, row]));
      for (const row of array(left.historyCoverage.months)) {
        const other = otherMonths.get(row.month); if (!other) continue;
        for (const field of ['sessionEvidenceUsd', 'sessionsWithDatedValue', 'recoveredMessageUsd']) {
          const expectedA = oldExpected.months.get(row.month)?.[field] ?? 0, expectedB = newExpected.months.get(row.month)?.[field] ?? 0;
          const stable = oldStable.months.get(row.month)?.[field] ?? 0;
          if (!same(row[field], expectedA, field) || !same(other[field], expectedB, field) || !same(stable, newStable.months.get(row.month)?.[field] ?? 0, field)) failures.push(`historyCoverage.months.${field}`);
          else { if (!same(row[field], other[field], field)) accepted.push({ scope: 'historyCoverage', field: `months.${field}`, before: row[field], after: other[field] }); row[field] = stable; other[field] = stable; }
        }
      }
    } catch { failures.push('historyCoverage.sessionValues.unavailable'); }
  }
  // Match repository identity before inspecting amounts; no membership or metadata is waived.
  const oldRepos = new Map(left.repositories.map(r => [r.repository.id, r])), newRepos = new Map(right.repositories.map(r => [r.repository.id, r]));
  if (oldRepos.size !== left.repositories.length || newRepos.size !== right.repositories.length) failures.push('repositories.multiplicity');
  for (const [id, a] of oldRepos) {
    const b = newRepos.get(id); if (!b) continue;
    const scope = `repository:${createHash('sha256').update(String(id)).digest('hex').slice(0, 12)}`;
    prove(a, b, array(before.sessions).filter(s => s.repositoryId === id), array(after.sessions).filter(s => s.repositoryId === id), scope, false);
  }
  left.repositories.sort((a, b) => a.repository.id.localeCompare(b.repository.id));
  right.repositories.sort((a, b) => a.repository.id.localeCompare(b.repository.id));
  return { left, right, accepted, failures: [...new Set(failures)].sort() };
}
