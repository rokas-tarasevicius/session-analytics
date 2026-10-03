import type { ModelRate } from "../types.ts";
import { validModelId } from "../public/model-id.js";
export { validModelId } from "../public/model-id.js";

/** Only lab prefixes are aliases. Never turn a reseller/deployment ID into a direct API price. */
export function normalizedModelId(model: string): string {
  return model.toLowerCase().replace(/^(?:anthropic|openai)\//, "")
    .replace(/(\d)\.(?=\d)/g, "$1-");
}

function withoutDate(model: string): string {
  return model.replace(/-(?:20\d{2}-\d{2}-\d{2}|20\d{6})$/, "");
}

type Match = { model: string; rate: ModelRate; match: "exact" | "alias" };
interface AliasIndex {
  normalized: Map<string, string | null>;
  dated: Map<string, string | null>;
  matches: Map<string, Match | undefined>;
}
// Rate tables are immutable and shared across unchanged observations. Negative matches are cached too.
const indexes = new WeakMap<Record<string, ModelRate>, AliasIndex>();
function aliasIndex(models: Record<string, ModelRate>): AliasIndex {
  const cached = indexes.get(models);
  if (cached) return cached;
  const index: AliasIndex = { normalized: new Map(), dated: new Map(), matches: new Map() };
  const add = (map: Map<string, string | null>, key: string, model: string) => map.set(key, map.has(key) ? null : model);
  for (const model of Object.keys(models)) {
    const normalized = normalizedModelId(model);
    add(index.normalized, normalized, model);
    add(index.dated, withoutDate(normalized), model);
  }
  indexes.set(models, index);
  return index;
}

export function findModelRate(models: Record<string, ModelRate>, model: string):
  Match | undefined {
  if (!validModelId(model)) return undefined;
  if (/^openai\/claude-/i.test(model) || /^anthropic\/(?!claude-)/i.test(model)) return undefined;
  if (Object.hasOwn(models, model)) return { model, rate: models[model]!, match: "exact" };
  const index = aliasIndex(models);
  if (index.matches.has(model)) return index.matches.get(model);
  const normalized = normalizedModelId(model);
  const base = withoutDate(normalized);
  const selected = index.normalized.has(normalized) ? index.normalized.get(normalized)
    : index.normalized.get(base) ?? index.dated.get(base);
  const result: Match | undefined = selected ? { model: selected, rate: models[selected]!, match: "alias" } : undefined;
  // Bound attacker-controlled misses; the indexes remain O(1) after the result cache fills.
  if (index.matches.size < 10000) index.matches.set(model, result);
  return result;
}
