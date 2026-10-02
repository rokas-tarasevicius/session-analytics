import { createHash } from "node:crypto";
import type { ContextPriceTier, ModelRate, PricingSource } from "../types.ts";
import { normalizedModelId, validModelId } from "./aliases.ts";
import { MAX_MODELS, MAX_PAYLOAD_BYTES, price, record, validateRate } from "./validation.ts";

export const SOURCE_URLS: Record<PricingSource, string> = {
  "models.dev": "https://models.dev/api.json",
  litellm: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
};
export const DEFAULT_SOURCES: PricingSource[] = ["models.dev", "litellm"];
export const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

export interface SourceSnapshot {
  version: 1;
  source: PricingSource;
  sourceUrl: string;
  fetchedAt: string;
  payloadSha256: string;
  models: Record<string, ModelRate>;
  rejectedModels: number;
}

function allowedModel(model: string, provider: "claude" | "codex"): boolean {
  if (!validModelId(model)) return false;
  const normalized = normalizedModelId(model);
  return provider === "claude" ? /^claude-/.test(normalized) : /^(?:gpt-|chatgpt-|o[1-9](?:-|$))/.test(normalized);
}

function cacheDefaults(rate: ModelRate): void {
  if (rate.provider === "claude" && rate.cacheWrite5mPerMillion !== undefined && rate.cacheWrite1hPerMillion === undefined) {
    rate.cacheWrite1hPerMillion = rate.inputPerMillion * 2;
    rate.assumptions = ["anthropic-cache-1h-2x"];
  }
  if (rate.provider === "codex") {
    rate.cacheWriteObservable = false;
    rate.cacheWriteMultiplier = 1.25;
    rate.assumptions = ["codex-cache-write-upper-1.25x"];
  }
}

function devTier(value: unknown, aboveInputTokens: unknown, rate: ModelRate): ContextPriceTier {
  const cost = record(value);
  if (!cost || typeof aboveInputTokens !== "number") throw new Error("Invalid tier.");
  const tier: ContextPriceTier = { aboveInputTokens, inputPerMillion: price(cost.input), outputPerMillion: price(cost.output) };
  if (cost.cache_read !== undefined) tier.cacheReadPerMillion = price(cost.cache_read);
  if (cost.cache_write !== undefined) tier.cacheWrite5mPerMillion = price(cost.cache_write);
  if (cost.cache_write_1h !== undefined) tier.cacheWrite1hPerMillion = price(cost.cache_write_1h);
  else if (rate.provider === "claude" && tier.cacheWrite5mPerMillion !== undefined) {
    tier.cacheWrite1hPerMillion = tier.inputPerMillion * 2;
    rate.assumptions = ["anthropic-cache-1h-2x"];
  }
  return tier;
}

function modelsDevRate(raw: unknown, provider: "claude" | "codex"): ModelRate | undefined {
  const model = record(raw), cost = record(model?.cost), modalities = record(model?.modalities);
  if (!cost) return undefined; // Models without prices (e.g. image generators) are not corrupt.
  if (Array.isArray(modalities?.output) && !modalities.output.includes("text")) return undefined;
  const rate: ModelRate = { provider, inputPerMillion: price(cost.input), outputPerMillion: price(cost.output), source: SOURCE_URLS["models.dev"] };
  if (cost.cache_read !== undefined) rate.cacheReadPerMillion = price(cost.cache_read);
  if (cost.cache_write !== undefined) rate.cacheWrite5mPerMillion = price(cost.cache_write);
  if (cost.cache_write_1h !== undefined) rate.cacheWrite1hPerMillion = price(cost.cache_write_1h);
  cacheDefaults(rate);
  if (cost.tiers !== undefined) {
    if (!Array.isArray(cost.tiers)) throw new Error("Invalid tiers.");
    rate.contextTiers = cost.tiers.map((value) => {
      const tier = record(value), boundary = record(tier?.tier);
      if (boundary?.type !== "context") throw new Error("Unsupported pricing tier.");
      return devTier(tier, boundary.size, rate);
    });
  } else if (cost.context_over_200k !== undefined) {
    rate.contextTiers = [devTier(cost.context_over_200k, 200_000, rate)];
  }
  return validateRate(rate, SOURCE_URLS["models.dev"]);
}

function litellmRate(raw: unknown, provider: "claude" | "codex"): ModelRate | undefined {
  const data = record(raw);
  if (!data || (data.mode !== undefined && data.mode !== "chat" && data.mode !== "responses")) return undefined;
  if (Array.isArray(data.supported_output_modalities) && !data.supported_output_modalities.includes("text")) return undefined;
  const unitPrice = (value: unknown): number => price(price(value) * 1_000_000);
  const rate: ModelRate = { provider, inputPerMillion: unitPrice(data.input_cost_per_token), outputPerMillion: unitPrice(data.output_cost_per_token), source: SOURCE_URLS.litellm };
  const fields = [
    ["cache_read_input_token_cost", "cacheReadPerMillion"],
    ["cache_creation_input_token_cost", "cacheWrite5mPerMillion"],
    ["cache_creation_input_token_cost_above_1hr", "cacheWrite1hPerMillion"],
  ] as const;
  for (const [key, field] of fields) if (data[key] !== undefined) rate[field] = unitPrice(data[key]);
  cacheDefaults(rate);
  const boundaries = Object.keys(data).flatMap((key) => {
    const match = /^input_cost_per_token_above_(\d+)k_tokens$/.exec(key);
    return match ? [Number(match[1])] : [];
  });
  if (boundaries.length) rate.contextTiers = boundaries.map((boundary) => {
    const suffix = `_above_${boundary}k_tokens`;
    const tier: ContextPriceTier = {
      aboveInputTokens: boundary * 1_000,
      inputPerMillion: unitPrice(data[`input_cost_per_token${suffix}`]),
      outputPerMillion: unitPrice(data[`output_cost_per_token${suffix}`]),
    };
    for (const [key, field] of fields) if (data[`${key}${suffix}`] !== undefined) tier[field] = unitPrice(data[`${key}${suffix}`]);
    if (provider === "claude" && tier.cacheWrite5mPerMillion !== undefined && tier.cacheWrite1hPerMillion === undefined) {
      tier.cacheWrite1hPerMillion = tier.inputPerMillion * 2;
      rate.assumptions = ["anthropic-cache-1h-2x"];
    }
    return tier;
  });
  return validateRate(rate, SOURCE_URLS.litellm);
}

/** Only direct Anthropic/OpenAI text inference prices; no batch, priority, region or resale rows. */
export function normalizeSource(source: PricingSource, payload: unknown): Pick<SourceSnapshot, "models" | "rejectedModels"> {
  const root = record(payload);
  if (!root) throw new Error("Invalid public pricing payload.");
  const models: Record<string, ModelRate> = Object.create(null);
  let rejectedModels = 0;
  const add = (id: string, raw: unknown, provider: "claude" | "codex"): void => {
    if (!allowedModel(id, provider)) return;
    try {
      const rate = source === "models.dev" ? modelsDevRate(raw, provider) : litellmRate(raw, provider);
      if (rate) models[id] = rate;
    } catch { rejectedModels += 1; }
  };
  if (source === "models.dev") {
    for (const [lab, provider] of [["anthropic", "claude"], ["openai", "codex"]] as const) {
      const entries = record(record(root[lab])?.models);
      if (entries) for (const [model, raw] of Object.entries(entries)) add(model, raw, provider);
    }
  } else {
    for (const [id, raw] of Object.entries(root)) {
      const provider = record(raw)?.litellm_provider;
      if (provider === "anthropic" || provider === "openai") add(id, raw, provider === "anthropic" ? "claude" : "codex");
    }
  }
  const count = Object.keys(models).length;
  if (!count || count > MAX_MODELS || rejectedModels > Math.max(5, count / 4)) {
    throw new Error("Public pricing payload has insufficient valid rates.");
  }
  return { models, rejectedModels };
}

/** The transport accepts only a constant source URL. Loopback overrides are for fixture tests only. */
export async function fetchSource(source: PricingSource, options: {
  offline?: boolean; now?: Date; fixtureUrl?: string; timeoutMs?: number;
} = {}): Promise<SourceSnapshot> {
  if (options.offline || process.env.SESSION_ANALYTICS_OFFLINE === "1") throw new Error("Pricing is offline.");
  let url = SOURCE_URLS[source];
  if (options.fixtureUrl) {
    const fixture = new URL(options.fixtureUrl);
    if (fixture.protocol !== "http:" || fixture.hostname !== "127.0.0.1" || fixture.username || fixture.password || fixture.search || fixture.hash) {
      throw new Error("Invalid pricing fixture URL.");
    }
    url = fixture.href;
  }
  const response = await fetch(url, {
    method: "GET", redirect: "error", credentials: "omit", referrerPolicy: "no-referrer",
    headers: { Accept: "application/json" }, signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("Pricing source unavailable."); }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_PAYLOAD_BYTES) throw new Error("Pricing payload too large.");
      chunks.push(chunk);
    }
  } catch { throw new Error("Pricing payload could not be read."); }
  const payload = Buffer.concat(chunks);
  const normalized = normalizeSource(source, JSON.parse(payload.toString("utf8")));
  return {
    version: 1, source, sourceUrl: SOURCE_URLS[source], fetchedAt: (options.now ?? new Date()).toISOString(),
    payloadSha256: sha256(payload), models: normalized.models, rejectedModels: normalized.rejectedModels,
  };
}
