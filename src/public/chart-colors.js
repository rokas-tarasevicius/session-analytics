/** Shared chart colours; provider/model identity is independent of rank, filters and values. */
export const brandPalette = {
  "light": {
    "--provider-codex": "#5c5c59",
    "--provider-claude": "#c96442",
    "--provider-cursor": "#008aa0",
    "--provider-copilot": "#8250df",
    "--provider-opencode": "#a8820d",
    "--provider-gemini": "#3a7be0",
    "--provider-unknown": "#90908a",
    "--provider-codex-0": "#262624",
    "--provider-codex-1": "#5c5c59",
    "--provider-codex-2": "#8a8a86",
    "--provider-codex-3": "#b5b5b0",
    "--provider-claude-0": "#9a4127",
    "--provider-claude-1": "#c96442",
    "--provider-claude-2": "#df8a66",
    "--provider-claude-3": "#ecb49a",
    "--provider-cursor-0": "color-mix(in oklab, var(--provider-cursor) 72%, #000)",
    "--provider-cursor-1": "var(--provider-cursor)",
    "--provider-cursor-2": "color-mix(in oklab, var(--provider-cursor) 72%, #fff)",
    "--provider-cursor-3": "color-mix(in oklab, var(--provider-cursor) 50%, #fff)",
    "--provider-copilot-0": "color-mix(in oklab, var(--provider-copilot) 72%, #000)",
    "--provider-copilot-1": "var(--provider-copilot)",
    "--provider-copilot-2": "color-mix(in oklab, var(--provider-copilot) 72%, #fff)",
    "--provider-copilot-3": "color-mix(in oklab, var(--provider-copilot) 50%, #fff)",
    "--provider-opencode-0": "color-mix(in oklab, var(--provider-opencode) 72%, #000)",
    "--provider-opencode-1": "var(--provider-opencode)",
    "--provider-opencode-2": "color-mix(in oklab, var(--provider-opencode) 72%, #fff)",
    "--provider-opencode-3": "color-mix(in oklab, var(--provider-opencode) 50%, #fff)",
    "--provider-gemini-0": "color-mix(in oklab, var(--provider-gemini) 72%, #000)",
    "--provider-gemini-1": "var(--provider-gemini)",
    "--provider-gemini-2": "color-mix(in oklab, var(--provider-gemini) 72%, #fff)",
    "--provider-gemini-3": "color-mix(in oklab, var(--provider-gemini) 50%, #fff)",
    "--provider-unknown-0": "color-mix(in oklab, var(--provider-unknown) 72%, #000)",
    "--provider-unknown-1": "var(--provider-unknown)",
    "--provider-unknown-2": "color-mix(in oklab, var(--provider-unknown) 72%, #fff)",
    "--provider-unknown-3": "color-mix(in oklab, var(--provider-unknown) 50%, #fff)",
    "--chart-neutral": "#4f4f55",
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
    "--provider-unknown": "#80807a",
    "--provider-codex-0": "#e6e6e1",
    "--provider-codex-1": "#9a9a96",
    "--provider-codex-2": "#73736f",
    "--provider-codex-3": "#6a6a66",
    "--provider-claude-0": "#f2a887",
    "--provider-claude-1": "#d8683f",
    "--provider-claude-2": "#ae4f2f",
    "--provider-claude-3": "#a65237",
    "--provider-cursor-0": "color-mix(in oklab, var(--provider-cursor) 70%, #fff)",
    "--provider-cursor-1": "var(--provider-cursor)",
    "--provider-cursor-2": "color-mix(in oklab, var(--provider-cursor) 72%, #000)",
    "--provider-cursor-3": "color-mix(in oklab, var(--provider-cursor) 52%, #000)",
    "--provider-copilot-0": "color-mix(in oklab, var(--provider-copilot) 70%, #fff)",
    "--provider-copilot-1": "var(--provider-copilot)",
    "--provider-copilot-2": "color-mix(in oklab, var(--provider-copilot) 72%, #000)",
    "--provider-copilot-3": "color-mix(in oklab, var(--provider-copilot) 52%, #000)",
    "--provider-opencode-0": "color-mix(in oklab, var(--provider-opencode) 70%, #fff)",
    "--provider-opencode-1": "var(--provider-opencode)",
    "--provider-opencode-2": "color-mix(in oklab, var(--provider-opencode) 72%, #000)",
    "--provider-opencode-3": "color-mix(in oklab, var(--provider-opencode) 52%, #000)",
    "--provider-gemini-0": "color-mix(in oklab, var(--provider-gemini) 70%, #fff)",
    "--provider-gemini-1": "var(--provider-gemini)",
    "--provider-gemini-2": "color-mix(in oklab, var(--provider-gemini) 72%, #000)",
    "--provider-gemini-3": "color-mix(in oklab, var(--provider-gemini) 52%, #000)",
    "--provider-unknown-0": "color-mix(in oklab, var(--provider-unknown) 70%, #fff)",
    "--provider-unknown-1": "var(--provider-unknown)",
    "--provider-unknown-2": "color-mix(in oklab, var(--provider-unknown) 72%, #000)",
    "--provider-unknown-3": "color-mix(in oklab, var(--provider-unknown) 52%, #000)",
    "--chart-neutral": "#b3b3ad",
    // Stepped for the dark surface, not flipped from the light ramp.
    "--category-0": "#357101",
    "--category-1": "#df58aa",
    "--category-2": "#56aa14",
    "--category-3": "#9a4680"
  }
};

// Non-brand categorical ramp (repositories, execution kind, effort). Every pair is
// at least 15 OKLab ΔE apart and from each provider hue in both themes; slots past
// the ramp repeat it with texture/dashes, so identity is never colour alone.
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

/** @param {string | null | undefined} model @param {string | null | undefined} [fallbackProvider] */
export function modelProvider(model, fallbackProvider) {
  const id = (model || "").toLowerCase();
  if (/claude|opus|sonnet|haiku|anthropic/.test(id)) return "claude";
  if (/^(gpt|o[1-9]|codex|chatgpt)|openai/.test(id)) return "codex";
  if (/gemini|google/.test(id)) return "gemini";
  return providerKey(fallbackProvider);
}

/** @param {string | null | undefined} model @returns {0 | 1 | 2 | 3} */
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

/** @param {string | null | undefined} provider @param {string | null | undefined} model */
export function modelColor(provider, model) { return `var(--provider-${modelProvider(model, provider)}-${modelTier(model)})`; }

/** @param {string} component @param {string} baseColor */
export function componentColor(component, baseColor) {
  if (component === "cached") return `color-mix(in oklab, ${baseColor} 45%, var(--surface))`;
  if (component === "write") return `color-mix(in oklab, ${baseColor} 70%, var(--surface))`;
  if (component === "output") return `color-mix(in oklab, ${baseColor} 70%, var(--text))`;
  if (component === "reported") return `repeating-linear-gradient(45deg, ${baseColor} 0 4px, var(--surface) 4px 6px)`;
  return baseColor;
}
