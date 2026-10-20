// Independent current accounting reconciliation of the raw-format projection.
// No analyzer, parser, index, aggregation, or pricing implementation imports.
import { readFile, writeFile } from 'node:fs/promises';
import { priceUsage } from './pricing-oracle.mjs';
const input = JSON.parse(await readFile('.lane/codex-observations.json', 'utf8'));
const snapshot = JSON.parse(await readFile(process.env.CODEX_ORACLE_REFERENCE ?? '../reference/snapshot-noindex-51ea561.json', 'utf8'));
let mapping = {}; try { mapping = JSON.parse(await readFile('.lane/codex-key-map.json', 'utf8')); } catch {}
const zero = () => [0, 0, 0, 0];
const add = (a, b) => a.map((x, i) => x + b[i]);
const subtract = (a, b) => a.map((x, i) => x - b[i]);
const positive = u => u[0] + u[2] > 0;
const equals = (a, b) => a.every((x, i) => x === b[i]);
const id = (total, last) => [...total.slice(0, 4), ...last.slice(0, 4)].join(':');
function time(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!match) return null;
  const [, y, m, d, h, minute, second] = match, calendar = new Date(Date.UTC(+y, +m - 1, +d));
  if (calendar.getUTCMonth() !== +m - 1 || calendar.getUTCDate() !== +d || +h > 23 || +minute > 59 || +second > 59) return null;
  const millis = Date.parse(value); return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}
const files = new Map(input.sessions.map(s => [s.file, { ...s, key: s.metas?.[0]?.id ?? s.key,
  birth: time(s.metas?.[0]?.at ?? s.metaAt), orderAt: time(s.metas?.[0]?.recordAt ?? s.metas?.[0]?.at ?? s.metaAt), parent: Object.hasOwn(s, 'firstFork') ? s.firstFork ?? s.firstParent : s.fork ?? s.parent,
  observations: [], turns: new Map(s.turnModels ?? []), compactions: new Set(s.compactionResponses ?? []) }]));
const threads = new Map();
for (const file of files.values()) { const group = threads.get(file.key) ?? []; group.push(file); threads.set(file.key, group); }
for (const group of threads.values()) group.sort((a, b) => (a.orderAt ?? '').localeCompare(b.orderAt ?? '') || a.file - b.file);
for (const observation of input.observations) {
  const file = files.get(observation.file); if (!file) continue;
  file.observations.push({ ...observation, key: file.key, at: time(observation.at), u: observation.u.slice(0, 4),
    total: observation.total?.slice(0, 4), threadTotal: observation.threadTotal?.slice(0, 4) });
}
// A continuation without a new model context inherits the preceding page.
for (const group of threads.values()) {
  let model = null;
  for (const file of group) {
    for (const observation of file.observations) if (observation.modelObserved === false && observation.model === null) observation.model = model;
    if (file.modelObserved) model = file.finalModel;
  }
}
const ancestry = file => {
  const result = new Set(); let parent = file.parent;
  while (parent && !result.has(parent)) { result.add(parent); parent = threads.get(parent)?.[0]?.parent; }
  return result;
};
const score = observation => { const activity = Date.parse(observation.responseAt), at = Date.parse(observation.at); return Number.isFinite(activity) && Number.isFinite(at) && activity <= at ? at - activity : Infinity; };
const precedes = (a, b) => !b || score(a) < score(b) || score(a) === score(b) && (a.at < b.at || a.at === b.at && a.file < b.file);
// First preserve every physical endpoint, then eliminate only proven ancestor replay.
const earliest = new Map(), perFileStates = new Map();
for (const file of files.values()) {
  const observations = new Map();
  for (const observation of file.observations) {
    if (observation.kind !== 'legacy' || observation.hasTotal === false || !observation.at) continue;
    const state = id(observation.total, observation.u), key = `${file.key}:${state}`;
    if (!earliest.has(key) || observation.at < earliest.get(key)) earliest.set(key, observation.at);
    if (precedes(observation, observations.get(state))) observations.set(state, observation);
  }
  perFileStates.set(file.file, observations);
}
const ledger = new Map();
for (const file of [...files.values()].sort((a, b) => ancestry(a).size - ancestry(b).size || a.file - b.file)) {
  for (const [state, observation] of perFileStates.get(file.file)) {
    if (file.birth && [...ancestry(file)].some(parent => earliest.get(`${parent}:${state}`) < file.birth)) continue;
    if (precedes(observation, ledger.get(state))) ledger.set(state, observation);
  }
}
// Explicit response/cumulative pairs reserve their legacy alias without asserting
// that unrelated equal-size requests share identity.
for (const file of [...files.values()].sort((a, b) => ancestry(a).size - ancestry(b).size || a.file - b.file)) {
  const seen = new Set();
  for (const observation of file.observations) {
    if (observation.kind !== 'response' || !observation.validUsage || !observation.at || !observation.hasThreadTotal ||
        !observation.response || observation.thread !== file.key || seen.has(observation.response)) continue;
    seen.add(observation.response);
    const state = id(observation.threadTotal, observation.u);
    if (ledger.has(state)) ledger.set(state, { ...observation, native: true });
  }
}
// Exact vector reachability proves complete interval coverage. Scalar overlap is insufficient.
function covered(before, after, event, file) {
  const next = new Map();
  for (const [state, owner] of ledger) {
    if (!event.at || owner.at > event.at) continue;
    const sameFile = owner.file === file.file;
    if (!sameFile && !(files.get(owner.file)?.key === file.parent && file.birth && earliest.get(`${file.parent}:${state}`) < file.birth)) continue;
    const vector = state.split(':').map(Number), end = vector.slice(0, 4), usage = vector.slice(4), start = subtract(end, usage);
    if (!positive(usage) || start.some((n, i) => n < before[i]) || end.some((n, i) => n > after[i])) continue;
    const key = start.join(':'); const edges = next.get(key) ?? []; edges.push(end); next.set(key, edges);
  }
  const pending = [before], visited = new Set();
  while (pending.length) { const point = pending.pop(), key = point.join(':'); if (equals(point, after)) return true; if (visited.has(key)) continue; visited.add(key); pending.push(...(next.get(key) ?? [])); }
  return false;
}
const claimed = new Set(), retained = [], diagnostics = { uncertainLegacyThreads: 0, supplementedResponses: 0, nativeAliasStates: [...ledger.values()].filter(o => o.native).length };
const uncertainty = new Set();
for (const [key, group] of threads) {
  const legacy = [], receipts = new Map(), turnModels = new Map(), compactions = new Set();
  for (const file of group) {
    for (const [turn, model] of file.turns) turnModels.set(turn, model);
    for (const response of file.compactions) compactions.add(response);
    for (const observation of file.observations) if (observation.kind === 'response' && observation.validUsage && observation.thread === key && observation.response && !receipts.has(observation.response)) receipts.set(observation.response, observation);
  }
  for (const file of group) {
    let previous = null, previousExposure = null;
    for (const event of file.observations) {
      if (event.kind !== 'legacy' || event.hasTotal === false) continue;
      const start = previous, exposureBefore = previousExposure, reset = previous && event.total.some((n, i) => n < previous[i]); previous = event.total; previousExposure = event.exposed;
      const state = id(event.total, event.u), owner = ledger.get(state);
      const owned = !owner || owner.file === file.file && owner.at === event.at;
      if (positive(event.u)) {
        if (owner?.native || !owned || claimed.has(state)) { if (owner && !owner.native && files.get(owner.file)?.key !== key) uncertainty.add(key); continue; }
        claimed.add(state); legacy.push({ ...event, basis: 'legacy', requestSizeKnown: true });
      } else {
        if (!start || reset) continue;
        const delta = subtract(event.total, start); if (!positive(delta) || !owned || claimed.has(state)) continue;
        if ([...receipts].some(([response, receipt]) => compactions.has(response) && receipt.hasThreadTotal && equals(receipt.threadTotal, event.total) && equals(receipt.u, delta))) continue;
        const interval = `${file.parent ?? key}:${start.join(':')}:${event.total.join(':')}`;
        if (claimed.has(interval) || covered(start, event.total, event, file)) continue;
        claimed.add(interval); claimed.add(state);
        legacy.push({ ...event, u: delta, exposed: { reasoning: !!exposureBefore?.totalReasoning && !!event.exposed?.totalReasoning, cached: !!exposureBefore?.totalCached && !!event.exposed?.totalCached }, basis: 'cumulative-interval', requestSizeKnown: false });
      }
    }
  }
  const available = legacy.map(event => ({ event, used: false })), unmatched = [];
  for (const [response, receipt] of receipts) {
    if (!positive(receipt.u)) continue;
    const unique = `${key}:${response}`; if (claimed.has(unique)) continue; claimed.add(unique);
    const pair = !compactions.has(response) && available.find(row => !row.used && row.event.turn === receipt.turn && equals(row.event.u, receipt.u));
    if (pair) pair.used = true; else unmatched.push(receipt);
  }
  const extra = [];
  for (const receipt of unmatched) {
    const pair = !compactions.has(receipt.response) && available.find(row => !row.used && equals(row.event.u, receipt.u));
    if (pair) pair.used = true;
    else { extra.push({ ...receipt, model: turnModels.get(receipt.turn) ?? receipt.model, basis: compactions.has(receipt.response) ? 'compaction-response' : 'response', requestSizeKnown: true }); diagnostics.supplementedResponses++; }
  }
  for (const event of [...legacy, ...extra]) {
    const file = files.get(event.file), model = event.model ?? (file.modelList.length === 1 ? file.modelList[0] : '<unknown>');
    const cost = priceUsage(model, { input_tokens: event.u[0], cached_input_tokens: event.u[1], output_tokens: event.u[2], reasoning_output_tokens: event.u[3] }, { timestamp: event.at, requestInputTokens: event.requestSizeKnown ? event.u[0] : null, currentPolicy: true });
    retained.push({ key: mapping[key] ?? key, nativeKey: key, at: event.at, model, execution: Object.hasOwn(event, 'currentSource') && event.currentSource === null ? 'unknown' : (event.currentSource ?? event.source ?? file.source) === 'subagent' ? 'subagent' : 'top-level',
      u: [event.u[0], Math.max(0, event.u[0] - event.u[1]), event.u[1], 0, 0, 0, event.u[2], event.u[3], Math.max(0, event.u[2] - event.u[3])],
      cost: { inputUsd: cost.inputUsd ?? 0, cachedInputUsd: cost.cachedInputUsd ?? 0, cacheWriteUsd: 0, outputUsd: cost.outputUsd ?? 0, totalUsd: cost.totalUsd, upperEstimateUsd: cost.upperEstimateUsd }, usd: cost.totalUsd, pricedTokens: cost.priced ? event.u[0] + event.u[2] : 0, basis: event.basis, file: event.file, line: event.line,
      response: event.response ?? null, exposed: event.exposed ?? {}, live: group.some(file => file.live) });
  }
}
diagnostics.uncertainLegacyThreads = uncertainty.size;
const tokenFields = ['inputTokens', 'uncachedInputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'cacheWrite5mInputTokens', 'cacheWrite1hInputTokens', 'outputTokens', 'reasoningOutputTokens', 'nonReasoningOutputTokens'];
const costFields = ['inputUsd', 'cachedInputUsd', 'cacheWriteUsd', 'outputUsd', 'totalUsd', 'upperEstimateUsd'];
const zeroCost = () => Object.fromEntries(costFields.map(field => [field, 0]));
const stats = () => ({ execution: { topLevelUsd: 0, subagentUsd: 0, unknownUsd: 0 }, cost: zeroCost(), u: Array(9).fill(0), usd: 0, calls: 0, days: {}, models: new Map(), velocity: new Map() });
const expected = new Map();
// A supplied snapshot can use an explicit calendar or come from another machine.
const local = new Intl.DateTimeFormat('en-CA', { timeZone: snapshot.velocity?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
for (const event of retained) {
  const session = expected.get(event.key) ?? stats(); expected.set(event.key, session);
  for (const field of costFields) session.cost[field] += event.cost[field];
  session.u = add(session.u, event.u); session.usd += event.usd; session.calls++;
  session.execution[event.execution === 'top-level' ? 'topLevelUsd' : event.execution === 'subagent' ? 'subagentUsd' : 'unknownUsd'] += event.usd;
  if (event.at) { const day = event.at.slice(0, 10); session.days[day] = (session.days[day] ?? 0) + event.usd; }
  const model = session.models.get(event.model) ?? stats(); session.models.set(event.model, model); for (const field of costFields) model.cost[field] += event.cost[field]; model.u = add(model.u, event.u); model.usd += event.usd; model.calls++;
  const parts = event.at ? Object.fromEntries(local.formatToParts(new Date(event.at)).map(part => [part.type, part.value])) : null;
  const day = parts ? `${parts.year}-${parts.month}-${parts.day}:${Number(parts.hour)}` : 'undated', dimension = `${day}:${event.model}:${event.execution}`;
  const cell = session.velocity.get(dimension) ?? { u: Array(9).fill(0), usd: 0, calls: 0, pricedTokens: 0, reasoningCovered: 0, cacheReadCovered: 0 };
  cell.u = add(cell.u, event.u); cell.usd += event.usd; cell.calls++; cell.pricedTokens += event.pricedTokens; cell.reasoningCovered += event.exposed.reasoning ? event.u[6] : 0; cell.cacheReadCovered += event.exposed.cached ? event.u[0] : 0; session.velocity.set(dimension, cell);
}
const actual = new Map(snapshot.sessions.filter(s => s.provider === 'codex' && s.transcript.status === 'ok').map(s => [s.sessionKey, s]));
const live = new Set([...threads].filter(([, group]) => group.some(file => file.live)).map(([key]) => mapping[key] ?? key));
const differences = [], near = (a, b) => Math.abs(a - b) <= Math.max(1e-8, Math.abs(a) * 1e-10);
function compare(key, scope, field, wanted, observed) { if (!Number.isFinite(wanted) || !Number.isFinite(observed) || (/usd/i.test(field) ? !near(wanted, observed) : wanted !== observed)) differences.push({ key, scope, field, expected: wanted, actual: observed, delta: observed - wanted }); }
let matched = 0;
for (const [key, session] of actual) {
  if (live.has(key)) continue;
  const wanted = expected.get(key) ?? stats(); matched++;
  tokenFields.forEach((field, n) => compare(key, 'session', field, wanted.u[n], session.tokens[field]));
  for (const field of costFields) compare(key, 'session', field, wanted.cost[field], session.cost[field]);
  for (const field of Object.keys(wanted.execution)) compare(key, 'execution', field, wanted.execution[field], session.costByExecution[field]); compare(key, 'session', 'modelCalls', wanted.calls, session.metrics.modelCalls);
  for (const model of new Set([...wanted.models.keys(), ...session.models.map(row => row.model)])) {
    const oracle = wanted.models.get(model) ?? stats(), observed = session.models.find(row => row.model === model);
    tokenFields.forEach((field, n) => compare(key, `model:${model}`, field, oracle.u[n], observed?.[field] ?? 0));
    for (const field of costFields) compare(key, `model:${model}`, field, oracle.cost[field], observed?.[field] ?? 0); compare(key, `model:${model}`, 'calls', oracle.calls, observed?.calls ?? 0);
  }
  for (const day of new Set([...Object.keys(wanted.days), ...Object.keys(session.spendByDay)])) compare(key, `day:${day}`, 'usd', wanted.days[day] ?? 0, session.spendByDay[day] ?? 0);
  const velocity = new Map();
  for (const [day, hour, dimension, values] of session.velocity?.buckets ?? []) {
    const d = session.velocity.dimensions[dimension], cell = `${day}:${hour}:${d.model}:${d.executionKind}`, row = velocity.get(cell) ?? Array(14).fill(0);
    velocity.set(cell, add(row, values));
  }
  for (const [dimension, values] of session.velocity?.undated ?? []) { const d = session.velocity.dimensions[dimension], cell = `undated:${d.model}:${d.executionKind}`; velocity.set(cell, add(velocity.get(cell) ?? Array(14).fill(0), values)); }
  for (const cell of new Set([...wanted.velocity.keys(), ...velocity.keys()])) {
    const oracle = wanted.velocity.get(cell) ?? { u: Array(9).fill(0), usd: 0, calls: 0, pricedTokens: 0, reasoningCovered: 0, cacheReadCovered: 0 }, observed = velocity.get(cell) ?? Array(14).fill(0);
    for (const [field, value, index] of [['usd', oracle.usd, 0], ['input', oracle.u[0], 1], ['uncached', oracle.u[1], 2], ['cached', oracle.u[2], 3], ['writes', oracle.u[3], 4], ['output', oracle.u[6], 5], ['reasoning', oracle.u[7], 6], ['calls', oracle.calls, 7], ['pricedTokens', oracle.pricedTokens, 10], ['reasoningCovered', oracle.reasoningCovered, 11], ['cacheReadCovered', oracle.cacheReadCovered, 12], ['cacheWriteCovered', 0, 13]]) compare(key, `velocity:${cell}`, field, value, observed[index]);
  }
}
const eligibleIdentities = new Set([...threads].filter(([, group]) => group.some(file => file.discovery?.validIdentity && file.discovery?.hasWorkingDirectory && file.discovery?.filenameMatches)).map(([key]) => mapping[key] ?? key));
const unclassifiedDiscovery = [...threads].filter(([, group]) => group.every(file => !file.discovery)).map(([key, group]) => ({ key: mapping[key] ?? key, files: group.length }));
const requiredIdentities = new Set([...eligibleIdentities, ...[...expected].filter(([, row]) => row.calls).map(([key]) => key)]);
const missing = [...requiredIdentities].filter(key => !actual.has(key) && !live.has(key)).map(key => {
  const row = expected.get(key) ?? stats(); return { key, reason: 'missing_native_identity', calls: row.calls, tokens: row.u[0] + row.u[6], usd: row.usd };
});
const excludedLive = [...threads].filter(([, group]) => group.some(file => file.live)).map(([nativeKey, group]) => {
  const key = mapping[nativeKey] ?? nativeKey, observed = actual.get(key), retained = expected.get(key) ?? stats();
  return { key, nativeKey, reason: 'activity_after_reference_cutoff', files: group.length,
    latestRawTimestamp: group.map(file => file.maxAt).filter(Boolean).sort().at(-1) ?? null,
    snapshot: observed ? { tokens: tokenFields.map(field => observed.tokens[field]), usd: observed.cost.totalUsd, calls: observed.metrics.modelCalls } : null,
    rawRetained: { tokens: retained.u, usd: retained.usd, calls: retained.calls } };
});
const uncertainLegacy = [...uncertainty].map(nativeKey => {
  const key = mapping[nativeKey] ?? nativeKey, wanted = expected.get(key) ?? stats();
  return { key, nativeKey, reason: 'counter_only_cross_file_identity_incomplete', files: threads.get(nativeKey)?.length ?? 0,
    retainedProjection: { tokens: wanted.u, usd: wanted.usd, calls: wanted.calls }, perSessionAttributionProven: false, additionalUsageUpperBound: null };
});
const report = { version: 1, generatedAt: snapshot.generatedAt, summary: { ...diagnostics, retainedEvents: retained.length, matched, rawIdentities: threads.size, eligibleIdentities: eligibleIdentities.size, unclassifiedDiscovery: unclassifiedDiscovery.length, live: live.size, differences: differences.length, differingSessions: new Set(differences.map(row => row.key)).size, missing: missing.length }, differences, missing, unclassifiedDiscovery, excludedLive, uncertainLegacy, retained };
await writeFile('.lane/codex-current.json', JSON.stringify(report));
console.log(JSON.stringify(report.summary));
