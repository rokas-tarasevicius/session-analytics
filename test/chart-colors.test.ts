import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { providerColors, providerIds } from "../src/public/providers.js";
import { brandPalette, categoryColor, categorySlotCount, componentColor, modelColor, modelProvider, modelTier, providerColor, providerKey } from "../src/public/chart-colors.js";

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
  assert.equal(modelColor("codex", "claude-opus-4.6"), "var(--provider-claude-0)");
  assert.equal(modelColor("claude", "gpt-5-mini"), "var(--provider-codex-3)");
  assert.equal(modelColor("missing", "<unknown>"), "var(--provider-unknown-1)");
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
