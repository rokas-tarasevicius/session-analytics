import { readFile, stat } from "node:fs/promises";
import type { AnalyzeOptions, ModelRate, ModelUsage, PricingCoverage, PublicModelRate, PricingPolicy,
  PricingSource, PricingStatus, RateCard, RateProvenance, RepositoryAnalytics } from "../types.ts";
import { findModelRate, normalizedModelId } from "./aliases.ts";
import { diffSource, type PriceChange } from "./diff.ts";
import { DEFAULT_SOURCES, SOURCE_URLS, sha256, migrateLegacyCacheWriteRate, type SourceSnapshot } from "./sources.ts";
import { pricingDirectory, readSnapshots, type ReviewedSnapshot, type StoredSnapshot } from "./store.ts";
import { MAX_PAYLOAD_BYTES, validateCard } from "./validation.ts";
import { applyBundledReviewedHistory } from "./reviewed-history.ts";
import { projectModelId } from "../public/model-id.js";

export interface PricingCatalog extends RateCard {
  history: StoredSnapshot[];
  /** Only default bundled cards opt into model-specific reviewed tariff history. */
  bundledReviewedHistory?: boolean;
  status: PricingStatus;
  /** Explicit custom cards may define a user-chosen equivalent for non-API models. */
  customRateCard?: boolean;
}
export interface ResolvedRate { rate: ModelRate; provenance: RateProvenance }
export const defaultRateCardPath = new URL("../../data/rate-cards.json", import.meta.url);

export function pricingConfiguration(options: AnalyzeOptions = {}): {
  offline: boolean; policy: PricingPolicy; sources: PricingSource[]; maxAgeDays: number;
} {
  const policy = options.rateCardPath ? "reviewed-only" : options.pricingPolicy ?? "reviewed-first";
  const sources = options.pricingSources ?? DEFAULT_SOURCES;
  const maxAgeDays = options.pricingMaxAgeDays ?? 7;
  if (!["reviewed-first", "api-first", "reviewed-only"].includes(policy) || !sources.length ||
      sources.some((source) => !DEFAULT_SOURCES.includes(source)) || new Set(sources).size !== sources.length ||
      !Number.isFinite(maxAgeDays) || maxAgeDays < 0 || maxAgeDays > 3650) throw new Error("Invalid pricing configuration.");
  return { offline: options.offline === true || process.env.SESSION_ANALYTICS_OFFLINE === "1", policy, sources, maxAgeDays };
}

export async function loadReviewed(path: string | URL = defaultRateCardPath): Promise<ReviewedSnapshot> {
  try {
    if ((await stat(path)).size > MAX_PAYLOAD_BYTES) throw new Error("Oversized rate card.");
    const payload = await readFile(path);
    const card = validateCard(JSON.parse(payload.toString("utf8")));
    return { version: 1, source: "reviewed", fetchedAt: `${card.effectiveDate}T00:00:00.000Z`,
      payloadSha256: sha256(payload), card };
  } catch { throw new Error("The configured rate card is invalid or unavailable."); }
}

interface Observation<T extends StoredSnapshot> { snapshot: T; time: number }
interface HistoryIndex {
  reviewed: Observation<ReviewedSnapshot>[];
  sources: Map<PricingSource, Observation<SourceSnapshot>[]>;
  times: Map<StoredSnapshot, number>;
  firstMatches: Map<string, { snapshot: SourceSnapshot; match: NonNullable<ReturnType<typeof findModelRate>> } | null>;
}
const historyIndexes = new WeakMap<PricingCatalog, HistoryIndex>();

function atTime<T extends StoredSnapshot>(observations: Observation<T>[], timestamp: number): T | undefined {
  if (!observations.length) return undefined;
  // Constant-time boundaries cover old transcripts and current-rate inspections.
  if (timestamp < observations[0]!.time) return observations[0]!.snapshot;
  if (timestamp >= observations.at(-1)!.time) return observations.at(-1)!.snapshot;
  let lower = 0, upper = observations.length;
  while (lower < upper) {
    const middle = (lower + upper) >>> 1;
    if (observations[middle]!.time <= timestamp) lower = middle + 1;
    else upper = middle;
  }
  return observations[lower - 1]!.snapshot;
}

export function resolveRate(catalog: PricingCatalog, model: string, timestamp?: string | null): ResolvedRate | undefined {
  // No published API tariff: a subscription preview cannot establish zero-dollar API coverage.
  const canonicalModel = normalizedModelId(model).replace(/-(?:20\d{2}-\d{2}-\d{2}|20\d{6})$/, "");
  if (!catalog.customRateCard && canonicalModel === "gpt-5-3-codex-spark") return undefined;
  const parsed = timestamp ? Date.parse(timestamp) : NaN;
  const time = Number.isFinite(parsed) ? parsed : Infinity;
  const index = historyIndexes.get(catalog)!;
  const reviewed = atTime(index.reviewed, time);
  const match = reviewed ? findModelRate(reviewed.card.models, model) : undefined;
  const resolved = (snapshot: StoredSnapshot, found: NonNullable<typeof match>, kind: RateProvenance["kind"]): ResolvedRate => ({
    rate: snapshot.source === "reviewed" ? found.rate : migrateLegacyCacheWriteRate(found.model, found.rate),
    provenance: {
      source: snapshot.source, kind, snapshotDate: snapshot.fetchedAt, payloadSha256: snapshot.payloadSha256,
      rateModel: found.model, match: found.match,
      temporal: !Number.isFinite(parsed) ? "undated" : index.times.get(snapshot)! <= time ? "at-or-before" : "oldest",
      assumptions: (snapshot.source === "reviewed" ? found.rate : migrateLegacyCacheWriteRate(found.model, found.rate)).assumptions ?? [],
    },
  });
  const reviewedMatch = (): ResolvedRate | undefined => {
    if (!match || !reviewed) return undefined;
    const selected = resolved(reviewed, match, "reviewed");
    return catalog.bundledReviewedHistory ? applyBundledReviewedHistory(selected, timestamp) : selected;
  };
  const pinned = match && (reviewed?.card.reviewedOverrides ?? Object.keys(reviewed?.card.models ?? {})).includes(match.model);
  if (catalog.status.policy === "reviewed-only") return reviewedMatch();
  if (catalog.status.policy === "reviewed-first" && pinned) return reviewedMatch();
  const candidates: ResolvedRate[] = [];
  for (const { source } of catalog.status.sources) {
    const observations = index.sources.get(source) ?? [];
    let selected = atTime(observations, time);
    let found = selected ? findModelRate(selected.models, model) : undefined;
    if (!found && Number.isFinite(parsed)) {
      // A catalog fetched before a model's listing cannot price it. Use its first later evidence,
      // explicitly labeled oldest; never resurrect a model removed after it was already observed.
      const key = `${source}:${model}`;
      let first = index.firstMatches.get(key);
      if (first === undefined) {
        first = null;
        for (const { snapshot } of observations) {
          const match = findModelRate(snapshot.models, model);
          if (match) { first = { snapshot, match }; break; }
        }
        if (index.firstMatches.size < 10000) index.firstMatches.set(key, first);
      }
      if (first && index.times.get(first.snapshot)! > time) { selected = first.snapshot; found = first.match; }
    }
    if (selected && found) candidates.push(resolved(selected, found, "api"));
  }
  // A newly introduced preferred feed must not replace earlier observed prices from another feed.
  const api = candidates.find(({ provenance }) => provenance.temporal !== "oldest") ?? candidates[0];
  if (api) return api;
  if (!match || !reviewed) return undefined;
  const fallback = resolved(reviewed, match, pinned ? "reviewed" : "fallback");
  return catalog.bundledReviewedHistory ? applyBundledReviewedHistory(fallback, timestamp) : fallback;
}

export function catalogFromSnapshots(reviewed: ReviewedSnapshot, snapshots: StoredSnapshot[],
  options: AnalyzeOptions = {}, now = new Date(), warnings: PricingStatus["warnings"] = []): PricingCatalog {
  const config = pricingConfiguration(options);
  const history = config.policy === "reviewed-only" ? [reviewed] : [
    ...snapshots.filter((snapshot) => snapshot.payloadSha256 !== reviewed.payloadSha256 &&
      // The active card is the revision for its effective date. An archived
      // definition on that same date must not win the oldest-rate fallback.
      !(snapshot.source === "reviewed" && snapshot.fetchedAt === reviewed.fetchedAt) &&
      (snapshot.source === "reviewed" || (config.sources.includes(snapshot.source) && Date.parse(snapshot.fetchedAt) <= now.valueOf()))),
    reviewed,
  ].sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
  const age = (date: string): number => Math.max(0, (now.valueOf() - Date.parse(date)) / 86_400_000);
  const sources = config.sources.map((source) => {
    const latest = history.findLast((snapshot): snapshot is SourceSnapshot => snapshot.source === source);
    return { source, url: SOURCE_URLS[source], fetchedAt: latest?.fetchedAt ?? null,
      payloadSha256: latest?.payloadSha256 ?? null, ageDays: latest ? age(latest.fetchedAt) : null,
      stale: !latest || age(latest.fetchedAt) > config.maxAgeDays, models: Object.keys(latest?.models ?? {}).length,
      rejectedModels: latest?.rejectedModels ?? 0 };
  });
  const newestSnapshotAt = sources.map(({ fetchedAt }) => fetchedAt).filter((date): date is string => date !== null).sort().at(-1) ?? null;
  const status: PricingStatus = {
    offline: config.offline, policy: config.policy, refreshAfterDays: config.maxAgeDays,
    newestSnapshotAt, ageDays: newestSnapshotAt ? age(newestSnapshotAt) : null,
    stale: config.policy !== "reviewed-only" && sources.some(({ stale }) => stale),
    snapshots: history.filter((snapshot) => snapshot.source !== "reviewed").length,
    sources, warnings: [...warnings],
  };
  const catalog: PricingCatalog = { currency: "USD", effectiveDate: reviewed.card.effectiveDate,
    models: Object.create(null), reviewedOverrides: reviewed.card.reviewedOverrides, history, status, customRateCard: !!options.rateCardPath };
  const index: HistoryIndex = { reviewed: [], sources: new Map(), times: new Map(), firstMatches: new Map() };
  for (const snapshot of history) {
    const time = Date.parse(snapshot.fetchedAt);
    index.times.set(snapshot, time);
    if (snapshot.source === "reviewed") index.reviewed.push({ snapshot, time });
    else {
      const observations = index.sources.get(snapshot.source) ?? [];
      observations.push({ snapshot, time });
      index.sources.set(snapshot.source, observations);
    }
  }
  historyIndexes.set(catalog, index);
  const ids = new Set(Object.keys(reviewed.card.models));
  for (const source of config.sources) {
    const latest = history.findLast((snapshot): snapshot is SourceSnapshot => snapshot.source === source);
    for (const id of Object.keys(latest?.models ?? {})) ids.add(id);
  }
  for (const id of [...ids].sort()) {
    const selected = resolveRate(catalog, id);
    if (selected) catalog.models[id] = selected.rate;
  }
  if (latestDiff(catalog).some(({ large }) => large)) status.warnings.push("large-price-change");
  if (sources.some(({ rejectedModels }) => rejectedModels > 0)) status.warnings.push("rejected-models");
  return catalog;
}

/** This function only reads local files. Analysis must never invoke the fetch/update module. */
export async function loadPricingCatalog(options: AnalyzeOptions = {}, now = new Date()): Promise<PricingCatalog> {
  const reviewed = await loadReviewed(options.rateCardPath);
  const cache = pricingConfiguration(options).policy === "reviewed-only"
    ? { snapshots: [], warnings: [] } : await readSnapshots(pricingDirectory(options));
  const catalog = catalogFromSnapshots(reviewed, cache.snapshots, options, now, cache.warnings);
  catalog.bundledReviewedHistory = !options.rateCardPath;
  return catalog;
}

export function latestDiff(catalog: PricingCatalog): PriceChange[] {
  return catalog.status.sources.flatMap(({ source }) => {
    const entries = catalog.history.filter((snapshot): snapshot is SourceSnapshot => snapshot.source === source);
    const latest = entries.at(-1);
    return latest ? diffSource(entries.at(-2), latest) : [];
  });
}

export function publicRateCard(catalog: PricingCatalog): RepositoryAnalytics["rateCard"] {
  return { currency: "USD", effectiveDate: catalog.effectiveDate, pricing: catalog.status,
    models: Object.keys(catalog.models).map((model) => {
      const selected = resolveRate(catalog, model)!;
      return { model, source: selected.rate.source, provenance: selected.provenance, rate: publicRate(selected.rate) };
    }) };
}

const finite = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Allowlisted numeric rate fields only; source URLs and assumptions already travel in `source`/`provenance`. */
export function publicRate(rate: ModelRate): PublicModelRate {
  const output: PublicModelRate = { provider: rate.provider, inputPerMillion: rate.inputPerMillion, outputPerMillion: rate.outputPerMillion };
  for (const key of ["cachedInputPerMillion", "cacheReadPerMillion", "cacheWrite5mPerMillion", "cacheWrite1hPerMillion", "cacheWriteMultiplier"] as const) {
    const value = finite(rate[key]);
    if (value !== undefined) output[key] = value;
  }
  if (typeof rate.cacheWriteObservable === "boolean") output.cacheWriteObservable = rate.cacheWriteObservable;
  if (rate.longContext) output.longContext = { inputMultiplier: rate.longContext.inputMultiplier,
    outputMultiplier: rate.longContext.outputMultiplier, thresholdInputTokens: rate.longContext.thresholdInputTokens };
  if (rate.contextTiers?.length) output.contextTiers = rate.contextTiers.map((tier) => {
    const projected: NonNullable<PublicModelRate["contextTiers"]>[number] = { aboveInputTokens: tier.aboveInputTokens,
      inputPerMillion: tier.inputPerMillion, outputPerMillion: tier.outputPerMillion };
    for (const key of ["cacheReadPerMillion", "cacheWrite5mPerMillion", "cacheWrite1hPerMillion"] as const) {
      const value = finite(tier[key]);
      if (value !== undefined) projected[key] = value;
    }
    return projected;
  });
  return output;
}

export function mergeProvenance(target: ModelUsage, incoming: RateProvenance[]): void {
  target.pricing ??= [];
  for (const provenance of incoming) {
    if (!target.pricing.some((item) => JSON.stringify(item) === JSON.stringify(provenance))) target.pricing.push(provenance);
  }
}

export function pricingCoverage(catalog: PricingCatalog, models: Iterable<string>): PricingCoverage {
  const seen = [...new Set(Array.from(models, projectModelId))].sort();
  const bySource: PricingCoverage["bySource"] = [...catalog.status.sources.map(({ source }) => ({ source, models: 0 })), { source: "reviewed", models: 0 }];
  const unpricedModels: string[] = [];
  for (const model of seen) {
    const selected = resolveRate(catalog, model);
    if (!selected) unpricedModels.push(model);
    else bySource.find(({ source }) => source === selected.provenance.source)!.models += 1;
  }
  return { modelsSeen: seen.length, modelsPriced: seen.length - unpricedModels.length,
    ratio: seen.length ? (seen.length - unpricedModels.length) / seen.length : null, bySource, unpricedModels };
}

/** Context tiers carry absolute cache rates; do not multiply them by an unrelated base input ratio. */
export function rateForContext(rate: ModelRate, inputTokens: number): ModelRate {
  const tier = rate.contextTiers?.findLast(({ aboveInputTokens }) => inputTokens > aboveInputTokens);
  if (!tier) return rate;
  return { ...rate, inputPerMillion: tier.inputPerMillion, outputPerMillion: tier.outputPerMillion,
    cachedInputPerMillion: undefined, cacheReadPerMillion: tier.cacheReadPerMillion ?? rate.cachedInputPerMillion ?? rate.cacheReadPerMillion,
    cacheWrite5mPerMillion: tier.cacheWrite5mPerMillion ?? rate.cacheWrite5mPerMillion,
    cacheWrite1hPerMillion: tier.cacheWrite1hPerMillion ?? rate.cacheWrite1hPerMillion, longContext: undefined,
    assumptions: [...(rate.assumptions ?? []).filter((code) => code !== "anthropic-cache-1h-2x" || tier.cacheWrite1hPerMillion === undefined),
      ...(tier.assumptions ?? [])] };
}
