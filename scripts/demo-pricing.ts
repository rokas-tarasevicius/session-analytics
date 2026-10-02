import { loadReviewed } from "../src/pricing/catalog.ts";
import { normalizeSource, sha256, SOURCE_URLS } from "../src/pricing/sources.ts";
import { pricingDirectory, saveSnapshot } from "../src/pricing/store.ts";

/** Canned public-rate shapes only; the demo never downloads prices or reads the user's cache. */
export async function seedDemoPricing(dataDir: string, now = new Date()): Promise<void> {
  const reviewed = await loadReviewed();
  const payload = { openai: { models: {} as Record<string, unknown> }, anthropic: { models: {} as Record<string, unknown> } };
  for (const [model, rate] of Object.entries(reviewed.card.models)) {
    const provider = rate.provider === "codex" ? payload.openai : payload.anthropic;
    provider.models[model] = { cost: { input: rate.inputPerMillion, output: rate.outputPerMillion,
      cache_read: rate.cacheReadPerMillion ?? rate.cachedInputPerMillion, cache_write: rate.cacheWrite5mPerMillion } };
  }
  const directory = pricingDirectory({ dataDir });
  await saveSnapshot(directory, reviewed);
  const normalized = normalizeSource("models.dev", payload);
  // One older observation allows the view to demonstrate history and source freshness.
  for (const days of [45, 2]) await saveSnapshot(directory, { version: 1, source: "models.dev",
    sourceUrl: SOURCE_URLS["models.dev"], fetchedAt: new Date(now.valueOf() - days * 86_400_000).toISOString(),
    payloadSha256: sha256(JSON.stringify(payload)), ...normalized });
  await saveSnapshot(directory, { version: 1, source: "litellm", sourceUrl: SOURCE_URLS.litellm,
    fetchedAt: new Date(now.valueOf() - 9 * 86_400_000).toISOString(), payloadSha256: sha256("synthetic-demo-pricing"),
    models: Object.fromEntries(Object.entries(normalized.models).map(([model, rate]) => [model, { ...rate, source: SOURCE_URLS.litellm }])),
    rejectedModels: 0 });
}
