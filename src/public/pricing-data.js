import { modelProvider, providerKey } from "./chart-colors.js";
import { projectModelId } from "./model-id.js";

const latest = (entries) => [...entries].sort((a, b) => (b.snapshotDate ?? "").localeCompare(a.snapshotDate ?? ""))[0];

/**
 * Model cards for the Pricing view. Only API-priced sessions contribute: provider-reported values never use a rate card.
 * "Most used" = API-equivalent usage value in the selection, then observed tokens, then calls, then model ID.
 * Unused cards are current rate-card models with no usage in the selection, ordered by provider then model ID.
 */
export function pricingModelCards(rateCard, sessions) {
  const rates = new Map((rateCard?.models ?? []).map((entry) => [entry.model, entry]));
  const cards = new Map();
  let tokens = 0, pricedTokens = 0;
  for (const session of sessions) {
    if (session.costBasis !== "api-list-price-equivalent") continue;
    for (const usage of session.models ?? []) {
      const eligible = usage.pricingCoverage?.eligibleTokens ?? usage.inputTokens + usage.outputTokens;
      const priced = usage.pricingCoverage?.pricedTokens ?? (usage.priced ? eligible : 0);
      tokens += eligible; pricedTokens += priced;
      const model = projectModelId(usage.model);
      const card = cards.get(model) ?? { model, priced: true, provenance: new Map(), sessions: new Set(), providers: new Map(),
        usage: { valueUsd: 0, upperEstimateUsd: 0, tokens: 0, pricedTokens: 0, calls: 0, sessions: 0,
          inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0 } };
      card.priced &&= !!usage.priced;
      card.sessions.add(session);
      card.providers.set(session.provider, (card.providers.get(session.provider) ?? 0) + eligible);
      for (const provenance of usage.pricing ?? []) card.provenance.set(JSON.stringify(provenance), provenance);
      const total = card.usage;
      total.valueUsd += usage.totalUsd ?? 0; total.upperEstimateUsd += usage.upperEstimateUsd ?? usage.totalUsd ?? 0;
      total.tokens += eligible; total.pricedTokens += priced; total.calls += usage.calls ?? 0;
      total.inputTokens += usage.inputTokens ?? 0; total.cachedInputTokens += usage.cachedInputTokens ?? 0;
      total.cacheWriteInputTokens += usage.cacheWriteInputTokens ?? 0; total.outputTokens += usage.outputTokens ?? 0;
      cards.set(model, card);
    }
  }
  const matched = new Set();
  const used = [...cards.values()].map((card) => {
    const provenance = [...card.provenance.values()];
    const entry = rates.get(card.model) ?? rates.get(latest(provenance)?.rateModel);
    if (entry) matched.add(entry.model);
    const sessionProvider = [...card.providers.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    return { model: card.model, used: true, priced: card.priced && provenance.length > 0,
      provider: entry?.rate?.provider ? providerKey(entry.rate.provider) : modelProvider(card.model, sessionProvider),
      rate: entry?.rate ?? null, source: entry?.source ?? null, current: entry?.provenance ?? null, provenance,
      usage: { ...card.usage, sessions: card.sessions.size,
        coverage: card.usage.tokens ? card.usage.pricedTokens / card.usage.tokens : null } };
  }).sort((a, b) => b.usage.valueUsd - a.usage.valueUsd || b.usage.tokens - a.usage.tokens
    || b.usage.calls - a.usage.calls || a.model.localeCompare(b.model));
  const unused = [...rates.values()].filter((entry) => !matched.has(entry.model) && !cards.has(entry.model)).map((entry) => ({
    model: entry.model, used: false, priced: true, provider: entry.rate?.provider ? providerKey(entry.rate.provider) : modelProvider(entry.model),
    rate: entry.rate ?? null, source: entry.source ?? null, current: entry.provenance ?? null, provenance: [], usage: null,
  })).sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
  const maxValue = Math.max(0, ...used.map(({ usage }) => usage.valueUsd));
  const maxTokens = Math.max(0, ...used.map(({ usage }) => usage.tokens));
  return { used, unused, tokens, pricedTokens, maxValue, maxTokens };
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
