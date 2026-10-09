import { modelProvider, providerKey } from "./chart-colors.js";
import { projectModelId } from "./model-id.js";
import { providerIds } from "./providers.js";
import { calendarDays, ledgerCells } from "./velocity-data.js";
import { ledgerMoney, pricedShare } from "./view-model.js";

const latest = (entries) => [...entries].sort((a, b) => (b.snapshotDate ?? "").localeCompare(a.snapshotDate ?? ""))[0];
const rank = (provider) => { const index = providerIds.indexOf(provider); return index < 0 ? providerIds.length : index; };

/**
 * Rate evidence behind each `${provider}:${model}` with ledger activity in the window: the distinct
 * `ModelUsage.pricing[]` snapshots and whether every contributing session priced that model completely.
 */
function rateEvidence(sessions, start, end) {
  const days = new Set(calendarDays(start, end)), result = new Map();
  if (!days.size) return result;
  for (const session of sessions) {
    if (!session.velocity) continue;
    const seen = new Set();
    for (const [day, , dimensionId] of ledgerCells(session.velocity)) {
      const dimension = session.velocity.dimensions[dimensionId];
      if (!dimension || seen.has(dimension.model) || !days.has(day)) continue;
      seen.add(dimension.model);
      const key = `${session.provider}:${dimension.model}`;
      const entry = result.get(key) ?? { provenance: new Map(), priced: true };
      for (const usage of session.models ?? []) if (usage.model === dimension.model) {
        entry.priced &&= !!usage.priced;
        for (const provenance of usage.pricing ?? []) entry.provenance.set(JSON.stringify(provenance), provenance);
      }
      result.set(key, entry);
    }
  }
  return result;
}

/**
 * Model cards for the Pricing view: one per (session provider, model), never merged across providers. Values are the
 * activity ledger for the selected dates, the same buildVelocity totals as Costs and the Summary KPI (`ledgerMoney`).
 * Provider-reported value never uses a rate card, so cards cover every other session and add up to the window's
 * API-equivalent value (`api`); `total` and `reported` reconcile them with the window's usage value.
 * Token coverage (`tokens`, `pricedTokens`, `coverage`) is the window's ledger pricing coverage, as on Costs.
 * "Most used" = usage value, then observed tokens, then calls, then model ID and provider.
 * Unused cards are current rate-card models no card uses, ordered by provider then model ID.
 */
export function pricingModelCards(rateCard, sessions, { start, end } = {}) {
  const rates = new Map((rateCard?.models ?? []).map((entry) => [entry.model, entry]));
  const all = ledgerMoney(sessions, { start, end });
  const apiSessions = sessions.filter((session) => session.costBasis !== "provider-reported");
  const ledger = ledgerMoney(apiSessions, { start, end }), evidence = rateEvidence(apiSessions, start, end);
  const matched = new Set(), usedModels = new Set();
  const used = ledger.models.map((row) => {
    const model = projectModelId(row.model), seen = evidence.get(row.id) ?? { provenance: new Map(), priced: true };
    const provenance = [...seen.provenance.values()];
    const entry = rates.get(model) ?? rates.get(latest(provenance)?.rateModel);
    if (entry) matched.add(entry.model);
    usedModels.add(model);
    const coverage = pricedShare(row.evidence);
    return { id: row.id, model, used: true, priced: seen.priced && provenance.length > 0 && (coverage === null || coverage === 1),
      provider: providerKey(row.provider), vendor: entry?.rate?.provider ? providerKey(entry.rate.provider) : modelProvider(model, row.provider),
      rate: entry?.rate ?? null, source: entry?.source ?? null, current: entry?.provenance ?? null, provenance,
      usage: { valueUsd: row.value, upperEstimateUsd: row.upper, tokens: row.evidence.eligible, pricedTokens: row.evidence.known,
        calls: row.calls, sessions: row.sessions, inputTokens: row.sums[1], cachedInputTokens: row.sums[3],
        cacheWriteInputTokens: row.sums[4], outputTokens: row.sums[5], coverage } };
  }).sort((a, b) => b.usage.valueUsd - a.usage.valueUsd || b.usage.tokens - a.usage.tokens
    || b.usage.calls - a.usage.calls || a.model.localeCompare(b.model) || rank(a.provider) - rank(b.provider));
  const unused = [...rates.values()].filter((entry) => !matched.has(entry.model) && !usedModels.has(entry.model)).map((entry) => {
    const provider = entry.rate?.provider ? providerKey(entry.rate.provider) : modelProvider(entry.model);
    return { id: `${provider}:${entry.model}`, model: entry.model, used: false, priced: true, provider, vendor: provider,
      rate: entry.rate ?? null, source: entry.source ?? null, current: entry.provenance ?? null, provenance: [], usage: null };
  }).sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
  const maxValue = Math.max(0, ...used.map(({ usage }) => usage.valueUsd));
  const maxTokens = Math.max(0, ...used.map(({ usage }) => usage.tokens));
  return { used, unused, tokens: all.evidence.eligible, pricedTokens: all.evidence.known, coverage: pricedShare(all.evidence),
    total: all.total, api: ledger.total, reported: all.reported, maxValue, maxTokens };
}

/** Rows of [label, USD per 1M or text] for a rate; omits classes the source does not publish. */
export function rateRows(rate) {
  if (!rate) return [];
  const rows = [["Input", rate.inputPerMillion]];
  if (rate.cachedInputPerMillion !== undefined) rows.push(["Cached input", rate.cachedInputPerMillion]);
  if (rate.cacheReadPerMillion !== undefined) rows.push(["Cache read", rate.cacheReadPerMillion]);
  if (rate.cacheWrite5mPerMillion !== undefined) rows.push(["Cache write (5 min)", rate.cacheWrite5mPerMillion]);
  if (rate.cacheWrite1hPerMillion !== undefined) rows.push(["Cache write (1 h)", rate.cacheWrite1hPerMillion]);
  if (rate.cacheWriteMultiplier !== undefined && rate.cacheWrite5mPerMillion === undefined)
    rows.push([rate.cacheWriteObservable === false ? "Cache write (upper estimate; not reported separately)" : "Cache write",
      rate.inputPerMillion * rate.cacheWriteMultiplier]);
  rows.push(["Output", rate.outputPerMillion]);
  return rows;
}

/** Long-context and context-tier rows: [label, input USD/1M, output USD/1M]. */
export function contextRows(rate) {
  if (!rate) return [];
  const rows = [];
  if (rate.longContext) rows.push([`Above ${rate.longContext.thresholdInputTokens.toLocaleString("en-GB")} input tokens`,
    rate.inputPerMillion * rate.longContext.inputMultiplier, rate.outputPerMillion * rate.longContext.outputMultiplier]);
  for (const tier of rate.contextTiers ?? []) rows.push([`Above ${tier.aboveInputTokens.toLocaleString("en-GB")} input tokens`, tier.inputPerMillion, tier.outputPerMillion]);
  return rows;
}
