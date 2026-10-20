import type { AnalyzeOptions, PricingUpdateAvailability, PricingUpdateResult } from "../types.ts";
import { validModelId } from "./aliases.ts";
import { loadPricingCatalog, pricingConfiguration, resolveRate, type PricingCatalog } from "./catalog.ts";
import { refreshPricingIfStale, updatePricing } from "./update.ts";

const DAY = 86_400_000;
const unavailable = "Background pricing update unavailable; cached rates remain in use.";
/** stale: policy age only; manual: Refresh snapshot, also pulls sources older than a day; unpriced: a scan saw unmatched models. */
type Reason = "stale" | "manual" | "unpriced";

/** Server-owned cache checks only. This never starts analysis or changes a displayed snapshot. */
export function createDashboardPricing(options: AnalyzeOptions, fixtures: {
  snapshot?: boolean;
  now?: () => Date;
  urls?: NonNullable<Parameters<typeof updatePricing>[1]>["urls"];
  timeoutMs?: number;
  schedule?: (callback: () => void, milliseconds: number) => () => void;
  log?: (line: string) => void;
  error?: (line: string) => void;
} = {}) {
  const configuration = pricingConfiguration(options);
  const enabled = !fixtures.snapshot && !configuration.offline && configuration.policy !== "reviewed-only";
  const now = fixtures.now ?? (() => new Date());
  const log = fixtures.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const error = fixtures.error ?? ((line: string) => process.stderr.write(`${line}\n`));
  let pending: Promise<PricingUpdateResult | null> | null = null;
  let cancel: (() => void) | undefined;
  let revision = 0, appliedRevision = 0, lastUnpricedAttempt = -Infinity;
  let fetchedAt: string | null = null;

  // Compare normalized tables, not changing raw hashes or observation times. The first fetch also adds evidence.
  const tables = (catalog: PricingCatalog): string => JSON.stringify(catalog.status.sources.map(({ source }) => {
    const latest = catalog.history.findLast((snapshot) => snapshot.source === source);
    return latest && latest.source !== "reviewed" ? latest.models : null;
  }));

  function check(reason: Reason = "stale", models: Iterable<string> = []): Promise<PricingUpdateResult | null> {
    if (!enabled) return Promise.resolve(null);
    if (pending) {
      const flight = pending;
      // A check that skipped fetching may not satisfy a joining check's reason/model set.
      return flight.then((result) => result ?? check(reason, models));
    }
    pending = (async () => {
      try {
        const at = now(), before = await loadPricingCatalog(options, at);
        const aged = before.status.sources.some(({ fetchedAt }) => !fetchedAt || at.valueOf() - Date.parse(fetchedAt) > DAY);
        if (reason === "unpriced") {
          if (at.valueOf() - lastUnpricedAttempt < DAY || !aged ||
              ![...new Set(models)].some((model) => validModelId(model) && /^(?:openai\/|anthropic\/)?(?:gpt-|claude-|chatgpt-|o[1-9])/.test(model)
                && !resolveRate(before, model))) return null;
          // Failed attempts count too; a missing model cannot cause a request loop.
          lastUnpricedAttempt = at.valueOf();
        }
        const fetchOptions = { urls: fixtures.urls, timeoutMs: fixtures.timeoutMs, now: at };
        const result = reason === "unpriced" || (reason === "manual" && aged) ? await updatePricing(options, fetchOptions)
          : await refreshPricingIfStale(options, fetchOptions);
        if (!result) return null;
        if (result.status === "failed" || result.status === "partial") error(unavailable);
        if (result.sources.some(({ status }) => status === "updated")) {
          const after = await loadPricingCatalog(options, now());
          if (tables(before) !== tables(after)) revision++;
          fetchedAt = after.status.newestSnapshotAt;
        }
        // The hint is in place before the announcement, so a reader of the line can rely on /api/health.
        log(`Background pricing update: ${result.status}. Refresh the dashboard snapshot to use new prices.`);
        return result;
      } catch { error(unavailable); return null; }
    })().finally(() => { pending = null; });
    return pending;
  }

  return {
    enabled, check,
    revision: () => revision,
    applied: (scannedRevision: number) => { appliedRevision = Math.max(appliedRevision, scannedRevision); },
    status: (): PricingUpdateAvailability => ({ updateAvailable: revision > appliedRevision, fetchedAt }),
    start: () => {
      if (!enabled || cancel) return;
      const schedule = fixtures.schedule ?? ((callback, milliseconds) => {
        const timer = setInterval(callback, milliseconds); timer.unref(); return () => clearInterval(timer);
      });
      cancel = schedule(() => { void check(); }, 6 * 60 * 60 * 1_000);
    },
    stop: () => { cancel?.(); cancel = undefined; },
  };
}
