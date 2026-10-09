/** Shared chart colours; provider/model identity is independent of rank, filters and values. */
// Model shades: slot 0 is the provider's brand colour and slots 1-3 step away from it in lightness (with a small
// hue/chroma shift). Every slot is at least 3:1 against the bar track (--surface-3) in its theme and the slots of
// one provider are at least ~9 OKLab ΔE (×100) apart; each ramp passes the dataviz ordinal checks. Codex is
// neutral: its steps sit darker (lighter in dark mode) than the grey used for Other and unknown.
export const brandPalette = {
  "light": {
    "--provider-codex": "#5c5c59",
    "--provider-claude": "#c96442",
    "--provider-cursor": "#008aa0",
    "--provider-copilot": "#8250df",
    "--provider-opencode": "#9c7a0a",
    "--provider-gemini": "#3a7be0",
    "--provider-unknown": "#858582",
    "--provider-codex-0": "#5c5c59",
    "--provider-codex-1": "#444441",
    "--provider-codex-2": "#2d2d2a",
    "--provider-codex-3": "#171715",
    "--provider-claude-0": "#c96442",
    "--provider-claude-1": "#852404",
    "--provider-claude-2": "#925436",
    "--provider-claude-3": "#5a180b",
    "--provider-cursor-0": "#008aa0",
    "--provider-cursor-1": "#034b55",
    "--provider-cursor-2": "#276679",
    "--provider-cursor-3": "#013036",
    "--provider-copilot-0": "#8250df",
    "--provider-copilot-1": "#460299",
    "--provider-copilot-2": "#673f97",
    "--provider-copilot-3": "#2a0368",
    "--provider-opencode-0": "#9c7a0a",
    "--provider-opencode-1": "#584101",
    "--provider-opencode-2": "#6f6024",
    "--provider-opencode-3": "#3b2901",
    "--provider-gemini-0": "#3a7be0",
    "--provider-gemini-1": "#014289",
    "--provider-gemini-2": "#415ca0",
    "--provider-gemini-3": "#002c57",
    "--provider-unknown-0": "#858582",
    "--provider-unknown-1": "#6c6c69",
    "--provider-unknown-2": "#565553",
    "--provider-unknown-3": "#40403d",
    "--chart-neutral": "#006855",
    // Non-brand series: greens and orchids, the hue families no provider uses.
    "--category-0": "#008719",
    "--category-1": "#dc6bc4",
    "--category-2": "#9ac32b",
    "--category-3": "#8a0e82"
  },
  "dark": {
    "--provider-codex": "#9a9a96",
    "--provider-claude": "#d8683f",
    "--provider-cursor": "#13a0b3",
    "--provider-copilot": "#9672ea",
    "--provider-opencode": "#b98a14",
    "--provider-gemini": "#4f8ae8",
    "--provider-unknown": "#6f7c7c",
    "--provider-codex-0": "#9a9a96",
    "--provider-codex-1": "#b6b6b3",
    "--provider-codex-2": "#d3d3d0",
    "--provider-codex-3": "#efeeeb",
    "--provider-claude-0": "#d8683f",
    "--provider-claude-1": "#f59768",
    "--provider-claude-2": "#fec5b4",
    "--provider-claude-3": "#ac5946",
    "--provider-cursor-0": "#13a0b3",
    "--provider-cursor-1": "#68c2da",
    "--provider-cursor-2": "#a0e3eb",
    "--provider-cursor-3": "#2b838b",
    "--provider-copilot-0": "#9672ea",
    "--provider-copilot-1": "#c39aff",
    "--provider-copilot-2": "#d3ccff",
    "--provider-copilot-3": "#7264bb",
    "--provider-opencode-0": "#b98a14",
    "--provider-opencode-1": "#d3b55f",
    "--provider-opencode-2": "#f7d49c",
    "--provider-opencode-3": "#9a712d",
    "--provider-gemini-0": "#4f8ae8",
    "--provider-gemini-1": "#8daefe",
    "--provider-gemini-2": "#b5d5ff",
    "--provider-gemini-3": "#3d75b5",
    "--provider-unknown-0": "#6f7c7c",
    "--provider-unknown-1": "#8d8c89",
    "--provider-unknown-2": "#ababa8",
    "--provider-unknown-3": "#cbcac8",
    "--chart-neutral": "#68bea8",
    // Stepped for the dark surface, not flipped from the light ramp.
    "--category-0": "#357101",
    "--category-1": "#df58aa",
    "--category-2": "#56aa14",
    "--category-3": "#9a4680"
  }
};

// Non-brand categorical ramp (repositories, execution kind, effort). Every pair is
// at least 15 OKLab ΔE apart and from each provider hue in both themes; slots past
// the ramp repeat it with a texture (areas) or markers (lines), so identity is never colour alone.
export const categorySlotCount = 4;
/** @param {number} slot Nonnegative integer identity slot. */
export function categoryColor(slot) { return `var(--category-${slot % categorySlotCount})`; }

/** @param {string | null | undefined} provider */
export function providerKey(provider) {
  switch (provider?.trim().toLowerCase()) {
    case "anthropic": case "claude": return "claude";
    case "openai": case "codex": case "gpt": case "chatgpt": return "codex";
    case "google": case "gemini": return "gemini";
    case "github": case "copilot": return "copilot";
    case "cursor": return "cursor";
    case "opencode": return "opencode";
    default: return "unknown";
  }
}

/** @param {string | null | undefined} provider */
export function providerColor(provider) { return `var(--provider-${providerKey(provider)})`; }

/** The vendor a model id belongs to (pricing uses it); charts colour by the provider that ran the model instead.
 * @param {string | null | undefined} model @param {string | null | undefined} [fallbackProvider] */
export function modelProvider(model, fallbackProvider) {
  const id = (model || "").toLowerCase();
  if (/claude|opus|sonnet|haiku|anthropic/.test(id)) return "claude";
  if (/^(gpt|o[1-9]|codex|chatgpt)|openai/.test(id)) return "codex";
  if (/gemini|google/.test(id)) return "gemini";
  return providerKey(fallbackProvider);
}

/** A model's preferred shade slot within its provider: a stable family tier (flagship 0, default 1, variants 2,
 * small 3). Two visible models may prefer the same slot; `modelSlots` resolves that.
 * @param {string | null | undefined} model @returns {0 | 1 | 2 | 3} */
export function modelTier(model) {
  const id = (model || "").toLowerCase().replace(/^(anthropic|openai)\//, "").replace(/\s*\[1m\]$/, "");
  if (!id || id === "<unknown>") return 1;
  if (/opus/.test(id)) return 0;
  if (/sonnet/.test(id)) return 1;
  if (/haiku|(?:^|[-_/])(?:mini|nano|flash|lite|spark)(?:$|[-_.\d/])/.test(id)) return 3;
  if (/-pro(?:-|$)|-max(?:-|$)|ultra/.test(id)) return 0;
  if (/codex/.test(id)) return 2;
  // Ignore version/date tokens, but retain named variants (sol, terra, etc.).
  const family = id.replace(/^(?:gpt|chatgpt|gemini|claude|o[1-9])(?:-|$)/, "").split(/[-_./\s]+/).filter((token) => token && !/^\d+$/.test(token)).join("-");
  if (!family) return 1;
  let hash = 0;
  for (const char of family) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return (hash ^ (hash >>> 16)) % 2 ? 2 : 1;
}

/** Shade slots per provider. */
export const modelSlotCount = 4;

/** The colour family a model row uses: the provider that ran it (a Cursor row of a Claude model stays Cursor's),
 * or the model's vendor when that provider is unknown.
 * @param {string | null | undefined} provider @param {string | null | undefined} model */
export function modelFamily(provider, model) {
  const key = providerKey(provider);
  return key === "unknown" ? modelProvider(model) : key;
}

/** @param {string | null | undefined} provider @param {number} slot */
export function slotColor(provider, slot) { return `var(--provider-${providerKey(provider)}-${((slot % modelSlotCount) + modelSlotCount) % modelSlotCount})`; }

/** A single model's colour at its preferred slot. Charts that show several models use `modelSlots` so that no two
 * visible models of one provider share a shade.
 * @param {string | null | undefined} provider @param {string | null | undefined} model */
export function modelColor(provider, model) { return slotColor(modelFamily(provider, model), modelTier(model)); }

const naturalCollator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/**
 * Gives each visible series its own shade slot within its provider. `preferred` is the series' stable slot and
 * `order` breaks ties between series that prefer the same slot (lower first), so a series keeps its shade while the
 * set of visible series is unchanged and never depends on value or rank. A series that loses its preferred slot
 * takes the nearest free one; once all `modelSlotCount` slots of a provider are taken, further series repeat their
 * preferred shade with `overflow: true` (charts add a texture or markers).
 * @param {Array<{ id: string, provider: string, preferred: number, order?: number }>} entries
 * @returns {Map<string, { provider: string, slot: number, overflow: boolean }>}
 */
export function allocateSlots(entries) {
  const result = new Map();
  const byProvider = new Map();
  for (const entry of entries) {
    const list = byProvider.get(entry.provider) ?? [];
    list.push(entry); byProvider.set(entry.provider, list);
  }
  for (const [provider, list] of byProvider) {
    const wrap = (slot) => ((slot % modelSlotCount) + modelSlotCount) % modelSlotCount;
    const sorted = [...list].sort((a, b) => wrap(a.preferred) - wrap(b.preferred) || (a.order ?? 0) - (b.order ?? 0) || naturalCollator.compare(a.id, b.id));
    // The provider's most-preferred visible series takes the brand shade (slot 0), so a provider is always recognisable
    // by its own colour, e.g. a lone Sonnet on Gemini CLI is Gemini blue rather than its darker standard-tier shade.
    const offset = sorted.length ? wrap(sorted[0].preferred) : 0;
    const taken = new Set();
    for (const entry of sorted) {
      if (result.has(entry.id)) continue;
      const preferred = wrap(entry.preferred) - offset;
      // Probe the preferred slot, then outward: +1, -1, +2, -2, ...
      let slot = null;
      for (let distance = 0; distance < modelSlotCount && slot === null; distance += 1) {
        for (const candidate of distance ? [preferred + distance, preferred - distance] : [preferred]) {
          if (candidate >= 0 && candidate < modelSlotCount && !taken.has(candidate)) { slot = candidate; break; }
        }
      }
      if (slot === null) result.set(entry.id, { provider, slot: preferred, overflow: true });
      else { taken.add(slot); result.set(entry.id, { provider, slot, overflow: false }); }
    }
  }
  return result;
}

/**
 * Shade slots for a set of visible models: each model gets its own slot within the provider that ran it.
 * Models that prefer the same family tier are ordered newest version first (natural order, descending).
 * @param {Array<{ id: string, provider: string, model: string }>} models
 */
export function modelSlots(models) {
  const order = [...models].sort((a, b) => naturalCollator.compare(b.model, a.model));
  const rank = new Map(order.map((item, index) => [item.id, index]));
  return allocateSlots(models.map((item) => ({ id: item.id, provider: modelFamily(item.provider, item.model), preferred: modelTier(item.model), order: rank.get(item.id) })));
}

/**
 * Re-picks the shade of overflow items in a display-ordered row (a stacked bar) so that no two adjacent items share
 * a slot. Items keep their slot when it already differs from both neighbours.
 * @template {{ slot: number, overflow: boolean }} T
 * @param {T[]} items
 * @returns {T[]}
 */
export function separateAdjacent(items) {
  const result = items.map((item) => ({ ...item }));
  for (let index = 0; index < result.length; index += 1) {
    const item = result[index];
    const previous = result[index - 1]?.slot, next = result[index + 1]?.slot;
    if (item.slot !== previous && item.slot !== next) continue;
    if (!item.overflow && item.slot !== previous) continue;
    for (const candidate of [item.slot, ...Array.from({ length: modelSlotCount }, (_, slot) => slot)]) {
      if (candidate !== previous && candidate !== next) { item.slot = candidate; break; }
    }
  }
  return result;
}

/** @param {string} component @param {string} baseColor */
export function componentColor(component, baseColor) {
  if (component === "cached") return `color-mix(in oklab, ${baseColor} 45%, var(--surface))`;
  if (component === "write") return `color-mix(in oklab, ${baseColor} 70%, var(--surface))`;
  if (component === "output") return `color-mix(in oklab, ${baseColor} 70%, var(--text))`;
  if (component === "reported") return `repeating-linear-gradient(45deg, ${baseColor} 0 4px, var(--surface) 4px 6px)`;
  return baseColor;
}
