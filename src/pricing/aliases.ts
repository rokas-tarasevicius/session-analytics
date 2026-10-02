import type { ModelRate } from "../types.ts";

/** Only lab prefixes are aliases. Never turn a reseller/deployment ID into a direct API price. */
export function normalizedModelId(model: string): string {
  return model.toLowerCase().replace(/^(?:anthropic|openai)\//, "")
    .replace(/(\d)\.(?=\d)/g, "$1-");
}

function withoutDate(model: string): string {
  return model.replace(/-(?:20\d{2}-\d{2}-\d{2}|20\d{6})$/, "");
}

export function validModelId(model: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,159}$/.test(model) && !model.includes("..");
}

export function findModelRate(models: Record<string, ModelRate>, model: string):
  { model: string; rate: ModelRate; match: "exact" | "alias" } | undefined {
  if (!validModelId(model)) return undefined;
  if (/^openai\/claude-/i.test(model) || /^anthropic\/(?!claude-)/i.test(model)) return undefined;
  if (Object.hasOwn(models, model)) return { model, rate: models[model]!, match: "exact" };
  const normalized = normalizedModelId(model);
  const entries = Object.entries(models);
  const exact = entries.filter(([key]) => normalizedModelId(key) === normalized);
  if (exact.length === 1) return { model: exact[0]![0], rate: exact[0]![1], match: "alias" };
  if (exact.length > 1) return undefined;
  const base = withoutDate(normalized);
  const aliases = entries.filter(([key]) => withoutDate(normalizedModelId(key)) === base);
  const undated = aliases.filter(([key]) => normalizedModelId(key) === base);
  const selected = undated.length === 1 ? undated[0] : aliases.length === 1 ? aliases[0] : undefined;
  return selected ? { model: selected[0], rate: selected[1], match: "alias" } : undefined;
}
