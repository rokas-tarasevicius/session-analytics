import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { providerColors, providerIds } from "../src/public/providers.js";
import { allocateSlots, brandPalette, categoryColor, categorySlotCount, componentColor, modelColor, modelFamily, modelProvider, modelSlots, modelTier, providerColor, providerKey, separateAdjacent, slotColor } from "../src/public/chart-colors.js";

test("provider aliases share the brand colour, including unknown and unsupported", () => {
  for (const provider of providerIds) assert.equal(providerColors[provider], providerColor(provider));
  const aliases = { claude: ["claude", "anthropic"], codex: ["codex", "openai", "gpt", "chatgpt"], gemini: ["gemini", "google"], copilot: ["copilot", "github"], cursor: ["cursor"], opencode: ["opencode"] };
  for (const [key, values] of Object.entries(aliases)) for (const value of values) {
    assert.equal(providerKey(` ${value.toUpperCase()} `), key);
    assert.equal(providerColor(value), `var(--provider-${key})`);
  }
  for (const value of ["unknown", "unsupported", "", undefined, "other"]) {
    assert.equal(providerKey(value), "unknown"); assert.equal(providerColor(value), "var(--provider-unknown)");
  }
});

test("model identity overrides a fallback provider and uses deterministic family tiers", () => {
  for (const model of ["claude-4", "opus-4", "sonnet-4", "haiku-4", "anthropic/custom"]) assert.equal(modelProvider(model, "codex"), "claude");
  for (const model of ["gpt-5", "o1", "o3-mini", "codex-mini", "chatgpt-5", "openai/custom"]) assert.equal(modelProvider(model, "claude"), "codex");
  for (const model of ["gemini-3", "google/custom"]) assert.equal(modelProvider(model, "claude"), "gemini");
  assert.equal(modelProvider("custom", "github"), "copilot"); assert.equal(modelProvider("custom", "other"), "unknown");
  for (const [model, tier] of [
    ["claude-opus-4.6", 0], ["claude-sonnet-4.6", 1], ["claude-haiku-4.5", 3], ["claude-sonnet-pro", 1], ["claude-opus-lite", 0],
    ["gpt-5-mini", 3], ["gpt-5-nano", 3], ["gemini-3-flash", 3], ["model-lite", 3], ["gpt-5-codex-spark", 3],
    ["gpt-5-pro", 0], ["model-max", 0], ["model-ultra", 0], ["gpt-5.3-codex", 2],
    ["gpt-5.4", 1], ["gemini-3", 1], ["<unknown>", 1], ["anthropic/claude-opus-4.6[1m]", 0],
    ["openai/gpt-5-mini[1m]", 3],
  ] as const) assert.equal(modelTier(model), tier, model);
  assert.equal(modelTier("openai/gpt-6-sol[1m]"), modelTier("gpt-5-sol"));
  assert.notEqual(modelTier("gpt-6-sol"), modelTier("gpt-6-terra"));
  assert.ok([1, 2].includes(modelTier("unfamiliar-family")));
  assert.equal(modelTier("unfamiliar-family"), modelTier("unfamiliar-family"));
  // Rows are coloured by the provider that ran the model; the model's vendor only fills in for an unknown provider.
  assert.equal(modelColor("codex", "claude-opus-4.6"), "var(--provider-codex-0)");
  assert.equal(modelColor("cursor", "claude-opus-5"), "var(--provider-cursor-0)");
  assert.equal(modelColor("claude", "gpt-5-mini"), "var(--provider-claude-3)");
  assert.equal(modelColor("missing", "gpt-5-mini"), "var(--provider-codex-3)");
  assert.equal(modelColor("missing", "<unknown>"), "var(--provider-unknown-1)");
  assert.equal(modelFamily("opencode", "claude-sonnet-5"), "opencode"); assert.equal(modelFamily(undefined, "claude-sonnet-5"), "claude");
  assert.equal(slotColor("gemini", 5), "var(--provider-gemini-1)");
});

test("every visible model gets its own shade within its provider, including the family-tier collisions", () => {
  const visible = (models: Array<[string, string]>) => models.map(([provider, model]) => ({ id: `${provider}:${model}`, provider, model }));
  // The pairs modelTier alone gives the same slot: opus-5/opus-4-8, sonnet-5/fable-5-1, gpt-5.5/gpt-5.6-terra.
  assert.equal(modelTier("claude-opus-5"), modelTier("claude-opus-4-8"));
  assert.equal(modelTier("claude-sonnet-5"), modelTier("claude-fable-5-1"));
  assert.equal(modelTier("gpt-5.5"), modelTier("gpt-5.6-terra"));
  const demo = visible([
    ["claude", "claude-opus-5"], ["claude", "claude-sonnet-5"], ["codex", "gpt-5.6-sol"], ["codex", "gpt-5.5"], ["claude", "claude-opus-4-8"],
    ["claude", "claude-fable-5-1"], ["codex", "gpt-5.6-terra"], ["cursor", "claude-opus-5"], ["gemini", "claude-sonnet-5"], ["opencode", "claude-sonnet-5"],
  ]);
  const slots = modelSlots(demo);
  const colours = demo.map(({ id }) => slotColor(slots.get(id)!.provider, slots.get(id)!.slot));
  assert.equal(new Set(colours).size, demo.length, "no two visible models share a shade");
  assert.ok(demo.every(({ id }) => !slots.get(id)!.overflow));
  for (const [first, second] of [["claude:claude-opus-5", "claude:claude-opus-4-8"], ["claude:claude-sonnet-5", "claude:claude-fable-5-1"], ["codex:gpt-5.5", "codex:gpt-5.6-terra"]] as const) {
    assert.notEqual(slots.get(first)!.slot, slots.get(second)!.slot, `${first} and ${second} must differ`);
  }
  assert.equal(slots.get("claude:claude-opus-5")!.slot, 0, "the newest flagship keeps the brand shade");
  // Cursor, Gemini and OpenCode rows of Claude models stay in their own provider's family, never Claude coral.
  for (const provider of ["cursor", "gemini", "opencode"]) assert.equal(slots.get(demo.find((item) => item.provider === provider)!.id)!.provider, provider);
  // Stable per id: the same visible set in any order gets the same slots (values and rank play no part).
  const shuffled = modelSlots([...demo].reverse());
  for (const { id } of demo) assert.deepEqual(shuffled.get(id), slots.get(id));
  // Removing a model no survivor collided with leaves the survivors' shades alone.
  const without = modelSlots(demo.filter(({ id }) => id !== "codex:gpt-5.6-sol"));
  for (const id of ["claude:claude-opus-5", "claude:claude-sonnet-5", "claude:claude-opus-4-8", "claude:claude-fable-5-1"]) assert.deepEqual(without.get(id), slots.get(id));
});

test("a provider with more models than shades repeats one with an overflow flag, and stacks never put equal shades side by side", () => {
  const claude = ["claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-fable-5-1", "claude-haiku-4-5", "claude-sonnet-4-6"].map((model) => ({ id: model, provider: "claude", model }));
  const slots = modelSlots(claude);
  const regular = claude.filter(({ id }) => !slots.get(id)!.overflow);
  assert.equal(regular.length, 4); assert.equal(new Set(regular.map(({ id }) => slots.get(id)!.slot)).size, 4);
  assert.equal(claude.filter(({ id }) => slots.get(id)!.overflow).length, 2);
  // Any display order: overflow segments are re-picked so neighbours differ; regular segments keep their shade.
  for (const order of [claude, [...claude].reverse(), [claude[4]!, claude[5]!, claude[0]!, claude[1]!, claude[2]!, claude[3]!]]) {
    const row = separateAdjacent(order.map(({ id }) => ({ id, ...slots.get(id)! })));
    for (let index = 1; index < row.length; index += 1) assert.notEqual(row[index]!.slot, row[index - 1]!.slot, `${row[index - 1]!.id} and ${row[index]!.id}`);
    for (const item of row) if (!item.overflow) assert.equal(item.slot, slots.get(item.id)!.slot);
  }
  const generic = allocateSlots([{ id: "a", provider: "codex", preferred: 0 }, { id: "b", provider: "codex", preferred: 2 }, { id: "c", provider: "codex", preferred: 2, order: 1 }, { id: "d", provider: "codex", preferred: 2, order: 2 }]);
  assert.deepEqual(["a", "b", "c", "d"].map((id) => generic.get(id)!.slot), [0, 2, 3, 1], "a lost preference probes +1, then -1");
  // A provider's most-preferred visible model takes the brand shade, so a lone Sonnet on Gemini CLI is Gemini's own colour.
  assert.equal(modelSlots([{ id: "gemini:claude-sonnet-5", provider: "gemini", model: "claude-sonnet-5" }]).get("gemini:claude-sonnet-5")!.slot, 0);
  const shifted = allocateSlots([{ id: "x", provider: "claude", preferred: 1 }, { id: "y", provider: "claude", preferred: 3 }]);
  assert.deepEqual([shifted.get("x")!.slot, shifted.get("y")!.slot], [0, 2], "preferences keep their spacing below the brand shade");
});

test("cost components retain the base hue, lightness encoding and reported stripes", () => {
  const base = "var(--provider-claude)";
  assert.equal(componentColor("input", base), base);
  assert.equal(componentColor("cached", base), `color-mix(in oklab, ${base} 45%, var(--surface))`);
  assert.equal(componentColor("write", base), `color-mix(in oklab, ${base} 70%, var(--surface))`);
  assert.equal(componentColor("output", base), `color-mix(in oklab, ${base} 70%, var(--text))`);
  assert.match(componentColor("reported", base), /repeating-linear-gradient\(45deg/);
});

/** OKLab ΔE ×100 between two sRGB hex colours (normal vision). */
function deltaE(first: string, second: string): number {
  const oklab = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) as [number, number, number];
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
  };
  const [a, b] = [oklab(first), oklab(second)];
  return 100 * Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
}

test("the categorical ramp is separable and cannot be mistaken for a provider brand hue", () => {
  assert.equal(categorySlotCount, 4);
  for (let slot = 0; slot < 12; slot += 1) assert.equal(categoryColor(slot), `var(--category-${slot % 4})`);
  for (const [theme, palette] of Object.entries(brandPalette)) {
    const ramp = Array.from({ length: categorySlotCount }, (_, slot) => palette[`--category-${slot}`]!);
    const brands = Object.entries(palette).filter(([name, value]) => /^--provider-[a-z]+$/.test(name) && value.startsWith("#"));
    assert.equal(brands.length, 7);
    for (const [index, hex] of ramp.entries()) {
      assert.match(hex, /^#[0-9a-f]{6}$/);
      for (const other of ramp.slice(index + 1)) assert.ok(deltaE(hex, other) >= 15, `${theme}: ${hex} and ${other} are too similar`);
      for (const [name, brand] of brands) assert.ok(deltaE(hex, brand) >= 15, `${theme}: ${hex} is too close to ${name}`);
    }
  }
});

/** WCAG 2 contrast ratio between two sRGB hex colours. */
function contrast(first: string, second: string): number {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [high, low] = [luminance(first), luminance(second)].sort((a, b) => b - a) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

test("model shades and the Other grey clear 3:1 against the bar track and stay apart within a provider", async () => {
  const css = await readFile(new URL("../src/public/styles.css", import.meta.url), "utf8");
  for (const [theme, palette] of Object.entries(brandPalette)) {
    const selector = theme === "light" ? ":root {" : ':root[data-theme="dark"] {';
    const body = css.slice(css.indexOf(selector) + selector.length).split("}")[0]!;
    const token = (name: string) => body.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6});`))![1]!;
    const track = token("--surface-3"), surface = token("--surface");
    for (const provider of ["codex", "claude", "cursor", "copilot", "opencode", "gemini", "unknown"]) {
      const ramp = [0, 1, 2, 3].map((slot) => palette[`--provider-${provider}-${slot}`]!);
      assert.equal(ramp[0], palette[`--provider-${provider}`], `${theme}: ${provider} slot 0 is the brand colour`);
      for (const hex of ramp) {
        assert.match(hex, /^#[0-9a-f]{6}$/);
        assert.ok(contrast(hex, track) >= 3, `${theme}: ${provider} ${hex} is ${contrast(hex, track).toFixed(2)}:1 against the track ${track}`);
        assert.ok(contrast(hex, surface) >= 3, `${theme}: ${provider} ${hex} against the surface`);
      }
      if (provider === "unknown") continue;
      for (const [index, hex] of ramp.entries()) for (const other of ramp.slice(index + 1)) assert.ok(deltaE(hex, other) >= 8, `${theme}: ${provider} ${hex} and ${other} are too similar (${deltaE(hex, other).toFixed(1)})`);
    }
    const other = palette["--provider-unknown"]!;
    for (let slot = 0; slot < 4; slot += 1) assert.ok(deltaE(other, palette[`--provider-codex-${slot}`]!) >= 10, `${theme}: Other grey vs Codex slot ${slot}`);
  }
});

test("CSS chart tokens mirror the complete shared palette in both themes", async () => {
  const css = await readFile(new URL("../src/public/styles.css", import.meta.url), "utf8");
  for (const [theme, palette] of Object.entries(brandPalette)) {
    const selector = theme === "light" ? ":root {" : ':root[data-theme="dark"] {';
    const body = css.slice(css.indexOf(selector) + selector.length).split("}")[0]!;
    const properties = Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2]!.trim()]));
    assert.equal(Object.keys(palette).length, 40);
    for (const [name, value] of Object.entries(palette)) assert.equal(properties[name], value, `${theme}: ${name}`);
    assert.deepEqual(Object.keys(properties).filter((name) => /^--(?:provider-|category-|chart-neutral$)/.test(name)).sort(), Object.keys(palette).sort());
  }
});

test("Velocity no longer defines or emits its own colour tokens", async () => {
  for (const file of ["velocity.css", "velocity.js"]) {
    const source = await readFile(new URL(`../src/public/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /--velocity-/);
  }
});
