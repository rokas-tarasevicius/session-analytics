import type { SourceSnapshot } from "../src/pricing/sources.ts";
import { normalizeSource, sha256, SOURCE_URLS } from "../src/pricing/sources.ts";
import type { PricingSource } from "../src/types.ts";

export const privateSentinel = "secret-pricing-content-never-export";
export function devPayload(input = 2) {
  return {
    openai: { models: {
      "gpt-fixture": { cost: { input, output: 10, cache_read: 0.2,
        tiers: [{ input: input * 2, output: 15, cache_read: 0.3, tier: { type: "context", size: 272000 } }],
        context_over_200k: { input: 100, output: 100 } },
        description: privateSentinel, source: `https://example.invalid/${privateSentinel}`, env: [privateSentinel],
        modalities: { output: ["text"] } },
      "gpt-image-fixture": { cost: { input: 1, output: 2 }, modalities: { output: ["image"] } },
    } },
    anthropic: { models: { "claude-fixture-4-5": { cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } } } },
    reseller: { models: { "gpt-fixture": { cost: { input: 0, output: 0 } } } },
  };
}
export function litePayload(input = 4) {
  return {
    "gpt-fixture": { litellm_provider: "openai", mode: "chat", input_cost_per_token: input / 1e6,
      output_cost_per_token: 10 / 1e6, cache_read_input_token_cost: 0.2 / 1e6,
      input_cost_per_token_above_272k_tokens: input * 2 / 1e6, output_cost_per_token_above_272k_tokens: 15 / 1e6,
      cache_read_input_token_cost_above_272k_tokens: 0.3 / 1e6, input_cost_per_token_priority: 99,
      input_cost_per_token_batches: 0, description: privateSentinel, source: privateSentinel },
    "claude-fixture-4-5": { litellm_provider: "anthropic", mode: "chat", input_cost_per_token: 3 / 1e6,
      output_cost_per_token: 15 / 1e6, cache_read_input_token_cost: 0.3 / 1e6,
      cache_creation_input_token_cost: 3.75 / 1e6, cache_creation_input_token_cost_above_1hr: 6 / 1e6,
      input_cost_per_token_above_200k_tokens: 6 / 1e6, output_cost_per_token_above_200k_tokens: 22.5 / 1e6,
      cache_read_input_token_cost_above_200k_tokens: 0.6 / 1e6,
      cache_creation_input_token_cost_above_200k_tokens: 7.5 / 1e6,
      cache_creation_input_token_cost_above_1hr_above_200k_tokens: 12 / 1e6 },
    "azure/gpt-fixture": { litellm_provider: "azure", input_cost_per_token: 0, output_cost_per_token: 0 },
    "gpt-image-fixture": { litellm_provider: "openai", mode: "image_generation", input_cost_per_token: 1, output_cost_per_token: 1 },
  };
}

export function sourceSnapshot(source: PricingSource, fetchedAt: string, input?: number): SourceSnapshot {
  const payload = source === "models.dev" ? devPayload(input) : litePayload(input);
  return { version: 1, source, sourceUrl: SOURCE_URLS[source], fetchedAt, payloadSha256: sha256(JSON.stringify(payload)),
    ...normalizeSource(source, payload) };
}
