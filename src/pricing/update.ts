import type { AnalyzeOptions, PricingSource, PricingUpdateResult } from "../types.ts";
import { loadPricingCatalog } from "./catalog.ts";
import { diffSource } from "./diff.ts";
import { fetchSource, type SourceSnapshot } from "./sources.ts";
import { pricingDirectory, saveSnapshot } from "./store.ts";

export async function updatePricing(options: AnalyzeOptions = {}, fixtures: {
  urls?: Partial<Record<PricingSource, string>>; now?: Date; timeoutMs?: number;
} = {}): Promise<PricingUpdateResult> {
  const catalog = await loadPricingCatalog(options, fixtures.now);
  if (catalog.status.offline || catalog.status.policy === "reviewed-only") {
    return { status: catalog.status.offline ? "offline" : "reviewed-only", sources: [], changes: [] };
  }
  const directory = pricingDirectory(options);
  // Archive the reviewed fallback and exception rules alongside fetched evidence.
  for (const snapshot of catalog.history.filter(({ source }) => source === "reviewed")) await saveSnapshot(directory, snapshot);
  const result: PricingUpdateResult = { status: "updated", sources: [], changes: [] };
  for (const { source } of catalog.status.sources) {
    try {
      const next = await fetchSource(source, { offline: catalog.status.offline, now: fixtures.now,
        fixtureUrl: fixtures.urls?.[source], timeoutMs: fixtures.timeoutMs });
      const previous = catalog.history.findLast((snapshot): snapshot is SourceSnapshot => snapshot.source === source);
      if (previous && Object.keys(next.models).length < Object.keys(previous.models).length / 2) {
        throw new Error("Pricing source lost most of its model coverage.");
      }
      const changes = diffSource(previous, next);
      await saveSnapshot(directory, next);
      result.sources.push({ source, status: "updated", models: Object.keys(next.models).length, rejectedModels: next.rejectedModels });
      result.changes.push(...changes);
    } catch { result.sources.push({ source, status: "failed", models: 0, rejectedModels: 0 }); }
  }
  const failed = result.sources.filter(({ status }) => status === "failed").length;
  result.status = failed === result.sources.length ? "failed" : failed ? "partial" : "updated";
  return result;
}

export async function refreshPricingIfStale(options: AnalyzeOptions = {}, fixtures: Parameters<typeof updatePricing>[1] = {}): Promise<PricingUpdateResult | null> {
  const catalog = await loadPricingCatalog(options, fixtures.now);
  if (catalog.status.offline || !catalog.status.stale) return null;
  return updatePricing(options, fixtures);
}
