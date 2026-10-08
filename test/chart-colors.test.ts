import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { providerColors, providerIds } from "../src/public/providers.js";
import { brandPalette, componentColor, modelColor, modelProvider, modelTier, providerColor, providerKey } from "../src/public/chart-colors.js";

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

test("CSS provider tokens and every model shade match the exported palettes in both themes", async () => {
  const css = await readFile(new URL("../src/public/styles.css", import.meta.url), "utf8");
  for (const [theme, palette] of Object.entries(brandPalette)) {
    const selector = theme === "light" ? ":root {" : ':root[data-theme="dark"] {';
    const body = css.slice(css.indexOf(selector) + selector.length).split("}")[0]!;
    const properties = Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2]!.trim()]));
    assert.equal(Object.keys(palette).length, 36);
    for (const [name, value] of Object.entries(palette)) assert.equal(properties[name], value, `${theme}: ${name}`);
  }
});
