/**
 * Independent Codex pricing oracle. Written from the bundled reviewed rate card,
 * docs/pricing.md and docs/providers.md before inspecting any analyzer source.
 * This module intentionally imports no production code and never opens transcripts.
 * It emits only counters, timestamps, model identifiers, and already-hashed keys.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const official = JSON.parse(fs.readFileSync(path.join(here, '../pricing/official-rates.json'), 'utf8'));
export const bundledCard = JSON.parse(fs.readFileSync(path.join(here, '../../data/rate-cards.json'), 'utf8'));

const versionIdentity = model => model.replace(/^openai\//, '').replace(/(?<=\d)[.-](?=\d)/g, '.');
const undatedIdentity = model => versionIdentity(model).replace(/(?:-|\.)(?:\d{8}|\d{4}[.-]\d{2}[.-]\d{2})$/, '');

export function lookupRate(model, card = bundledCard) {
  const entries = Object.entries(card.models).filter(([, rate]) => rate.provider === 'codex');
  const exact = entries.find(([id]) => id === model);
  if (exact) return { model: exact[0], rate: exact[1], match: 'exact' };
  for (const normalize of [versionIdentity, undatedIdentity]) {
    const matches = entries.filter(([id]) => normalize(id) === normalize(model));
    if (matches.length === 1) return { model: matches[0][0], rate: matches[0][1], match: 'alias' };
    if (matches.length > 1) {
      const undated = matches.filter(([id]) => undatedIdentity(id) === versionIdentity(id));
      if (undated.length === 1) return { model: undated[0][0], rate: undated[0][1], match: 'alias' };
    }
  }
  return null;
}

/** Input and output include their cache and reasoning subsets. */
export function normalizeUsage(usage) {
  const n = (...fields) => {
    for (const field of fields) if (Number.isFinite(usage[field]) && usage[field] >= 0) return usage[field];
    return 0;
  };
  const input = n('input_tokens', 'inputTokens', 'input');
  const cached = Math.min(input, n('cached_input_tokens', 'cachedInputTokens', 'cached'));
  const output = n('output_tokens', 'outputTokens', 'output');
  const reasoning = Math.min(output, n('reasoning_output_tokens', 'reasoningOutputTokens', 'reasoning'));
  return { input, cached, uncached: input - cached, output, reasoning, nonReasoning: output - reasoning, total: input + output };
}

/**
 * requestInputTokens is the input size of ONE request, never a session aggregate.
 * Null explicitly means unknown size and uses base rates, with premium uncertainty
 * separately exposed as maximumLongContextUsd. Summing this upper bound does not
 * assert that any request was long.
 */
export function priceUsage(model, usage, { requestInputTokens = null, card = bundledCard, timestamp = null, currentPolicy = false } = {}) {
  const tokens = normalizeUsage(usage);
  const match = lookupRate(model, card);
  if (!match) return { priced: false, ...tokens, totalUsd: 0, upperEstimateUsd: 0, maximumLongContextUsd: null };
  let rate = match.rate;
  const day = typeof timestamp === 'string' ? timestamp.slice(0, 10) : null;
  const interval = day && official.history.find(h => h.model === match.model && h.input !== undefined && (!h.from || day >= h.from) && day < h.untilExclusive);
  if (interval) rate = { ...rate, inputPerMillion: interval.input, cachedInputPerMillion: interval.cacheRead, outputPerMillion: interval.output };
  const long = rate.longContext;
  const premium = Number.isFinite(requestInputTokens) && long && requestInputTokens > long.thresholdInputTokens;
  const inputMultiplier = premium ? long.inputMultiplier : 1;
  const outputMultiplier = premium ? long.outputMultiplier : 1;
  const inputUsd = tokens.uncached * rate.inputPerMillion * inputMultiplier / 1e6;
  const cachedInputUsd = tokens.cached * (rate.cachedInputPerMillion ?? rate.cacheReadPerMillion ?? rate.inputPerMillion) * inputMultiplier / 1e6;
  const outputUsd = tokens.output * rate.outputPerMillion * outputMultiplier / 1e6;
  const totalUsd = inputUsd + cachedInputUsd + outputUsd;
  // The legacy OpenAI families have no separately billed cache-write
  // class. Modern paid-write families retain their documented upper bound. Preserve the historical diagnostic default for old baseline reports.
  const noWritePremium = currentPolicy && card === bundledCard && rate.provider === 'codex' &&
    ['gpt-5.3-codex', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.5'].includes(undatedIdentity(match.model)) &&
    rate.cacheWriteObservable === false && rate.cacheWriteMultiplier === 1.25 &&
    rate.cacheWrite5mPerMillion === undefined && rate.cacheWrite1hPerMillion === undefined;
  const upperEstimateUsd = totalUsd + (noWritePremium ? 0 : inputUsd * Math.max(0, (rate.cacheWriteMultiplier ?? 1) - 1));
  const maximumLongContextUsd = long && requestInputTokens === null
    ? (inputUsd + cachedInputUsd) * long.inputMultiplier + outputUsd * long.outputMultiplier
    : totalUsd;
  return { priced: true, ...tokens, inputUsd, cachedInputUsd, outputUsd, totalUsd, upperEstimateUsd, maximumLongContextUsd, longContext: !!premium, rateModel: match.model };
}

const zero = () => ({ sessions: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, referenceUsd: 0, baseUsd: 0, maximumLongContextUsd: 0, referenceUpperUsd: 0, baseUpperUsd: 0 });
const add = (target, usage, cost) => {
  target.inputTokens += usage.inputTokens;
  target.cachedInputTokens += usage.cachedInputTokens;
  target.outputTokens += usage.outputTokens;
  target.reasoningOutputTokens += usage.reasoningOutputTokens;
  target.referenceUsd += usage.totalUsd;
  target.referenceUpperUsd += usage.upperEstimateUsd;
  target.baseUsd += cost.totalUsd;
  target.baseUpperUsd += cost.upperEstimateUsd;
  target.maximumLongContextUsd += cost.maximumLongContextUsd ?? 0;
};

export function auditSnapshot(snapshot, { excludedSessionKeys = new Set() } = {}) {
  const sessions = [];
  const byModel = new Map();
  const bySessionStartMonth = new Map();
  const byActivityMonthUsd = new Map();
  const invariantFailures = [];
  const knownRateModels = new Set();
  const unknownModels = new Set();
  const total = zero();
  const near = (a, b) => Math.abs(a - b) < 1e-7;
  for (const session of snapshot.sessions) {
    if (session.provider !== 'codex' || excludedSessionKeys.has(session.sessionKey)) continue;
    const month = (session.firstEventAt ?? session.createdAt ?? 'unknown').slice(0, 7);
    if (!bySessionStartMonth.has(month)) bySessionStartMonth.set(month, zero());
    const monthRow = bySessionStartMonth.get(month);
    // Per-request size coverage is no longer published; aggregate pricing is never assumed exact.
    const aggregateBaseIsExact = false;
    const row = { sessionKey: session.sessionKey, month, ...zero(), models: [], aggregateBaseIsExact };
    row.sessions = 1;
    const modelTokenTotals = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
    for (const model of session.models) {
      const price = priceUsage(model.model, model);
      if (price.priced) knownRateModels.add(model.model); else unknownModels.add(model.model);
      add(row, model, price);
      if (!byModel.has(model.model)) byModel.set(model.model, zero());
      add(byModel.get(model.model), model, price);
      byModel.get(model.model).sessions++;
      row.models.push({ model: model.model, baseUsd: price.totalUsd, referenceUsd: model.totalUsd, premiumUsd: model.totalUsd - price.totalUsd });
      for (const field of Object.keys(modelTokenTotals)) modelTokenTotals[field] += model[field];
      if (model.inputTokens !== model.uncachedInputTokens + model.cachedInputTokens) invariantFailures.push({ sessionKey: session.sessionKey, model: model.model, invariant: 'input-partition' });
      if (model.outputTokens !== model.reasoningOutputTokens + model.nonReasoningOutputTokens) invariantFailures.push({ sessionKey: session.sessionKey, model: model.model, invariant: 'output-partition' });
      if (!near(model.totalUsd, model.inputUsd + model.cachedInputUsd + model.outputUsd + model.cacheWriteUsd)) invariantFailures.push({ sessionKey: session.sessionKey, model: model.model, invariant: 'cost-components' });
      if (model.pricingCoverage?.eligibleTokens !== model.inputTokens + model.outputTokens) invariantFailures.push({ sessionKey: session.sessionKey, model: model.model, invariant: 'coverage-denominator' });
      if (price.priced && model.pricingCoverage?.pricedTokens !== model.inputTokens + model.outputTokens) invariantFailures.push({ sessionKey: session.sessionKey, model: model.model, invariant: 'priced-token-coverage' });
      const matched = lookupRate(model.model);
      if (matched && !near(model.upperEstimateUsd, model.totalUsd + model.inputUsd * Math.max(0, (matched.rate.cacheWriteMultiplier ?? 1) - 1))) invariantFailures.push({ sessionKey: session.sessionKey, model: model.model, invariant: 'cache-write-upper-premium' });
      if (price.priced && model.totalUsd < price.totalUsd - 1e-7) invariantFailures.push({ sessionKey: session.sessionKey, model: model.model, invariant: 'cost-below-base', deltaUsd: model.totalUsd - price.totalUsd });
      if (price.priced && model.totalUsd > price.maximumLongContextUsd + 1e-7) invariantFailures.push({ sessionKey: session.sessionKey, model: model.model, invariant: 'cost-above-long-maximum', deltaUsd: model.totalUsd - price.maximumLongContextUsd });
    }
    for (const [field, expected] of Object.entries(modelTokenTotals)) if (session.tokens[field] !== expected) invariantFailures.push({ sessionKey: session.sessionKey, invariant: `model-sum-${field}`, actual: session.tokens[field], expected });
    if (!near(session.cost.totalUsd, row.referenceUsd)) invariantFailures.push({ sessionKey: session.sessionKey, invariant: 'model-cost-sum', actual: session.cost.totalUsd, expected: row.referenceUsd });
    if (!near(session.cost.upperEstimateUsd, row.referenceUpperUsd)) invariantFailures.push({ sessionKey: session.sessionKey, invariant: 'model-upper-cost-sum' });
    if (session.metrics.modelCalls !== session.models.reduce((n, model) => n + model.calls, 0)) invariantFailures.push({ sessionKey: session.sessionKey, invariant: 'model-call-sum' });
    if (!near(session.cost.totalUsd, Object.values(session.costByExecution).reduce((n, value) => n + value, 0))) invariantFailures.push({ sessionKey: session.sessionKey, invariant: 'execution-cost-sum' });
    for (const field of Object.keys(total)) { total[field] += row[field]; monthRow[field] += row[field]; }
    const dayTotal = Object.values(session.spendByDay).reduce((a, b) => a + b, 0);
    if (!near(dayTotal, session.cost.totalUsd)) invariantFailures.push({ sessionKey: session.sessionKey, invariant: 'daily-cost-sum', actual: dayTotal, expected: session.cost.totalUsd });
    for (const [day, usd] of Object.entries(session.spendByDay)) {
      const month = day.slice(0, 7);
      byActivityMonthUsd.set(month, (byActivityMonthUsd.get(month) ?? 0) + usd);
    }
    row.premiumUsd = row.referenceUsd - row.baseUsd;
    sessions.push(row);
  }
  return {
    generatedAt: snapshot.generatedAt,
    basis: 'Current reviewed-card arithmetic; input and output include cached/reasoning subsets. Long-context premiums are per-request and cannot be recovered exactly from session aggregates.',
    total, knownRateModels: [...knownRateModels].sort(), unknownModels: [...unknownModels].sort(),
    byModel: [...byModel].map(([model, row]) => ({ model, ...row, premiumUsd: row.referenceUsd - row.baseUsd })),
    bySessionStartMonth: [...bySessionStartMonth].map(([month, row]) => ({ month, ...row })).sort((a, b) => a.month.localeCompare(b.month)),
    byActivityMonthUsd: [...byActivityMonthUsd].map(([month, usd]) => ({ month, usd })).sort((a, b) => a.month.localeCompare(b.month)),
    invariantFailures, sessions,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const snapshot = JSON.parse(fs.readFileSync(process.argv[2] ?? path.join(here, '../../../reference/snapshot-noindex-51ea561.json'), 'utf8'));
    const report = auditSnapshot(snapshot);
    if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ generatedAt: report.generatedAt, total: report.total, byModel: report.byModel, byActivityMonthUsd: report.byActivityMonthUsd, invariantFailures: report.invariantFailures, knownRateModels: report.knownRateModels, unknownModels: report.unknownModels }, null, 2));
  } catch {
    console.error('Pricing oracle could not read or validate its inputs.');
    process.exitCode = 1;
  }
}
