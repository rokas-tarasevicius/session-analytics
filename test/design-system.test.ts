import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const styles = ["styles.css", "velocity.css", "pricing.css", "tools.css", "interop.css"];
const readCss = (file: string) => readFile(new URL(`../src/public/${file}`, import.meta.url), "utf8");

function tokens(css: string, selector: string): Record<string, string> {
  assert.ok(css.includes(selector), selector);
  const body = css.slice(css.indexOf(selector) + selector.length).split("}")[0]!;
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [match[1]!, match[2]!.trim()]));
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(first: string, second: string): number {
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** OKLab ΔE ×100 between two sRGB hex colours (normal vision), as in chart-colors.test.ts. */
function deltaE(first: string, second: string): number {
  const oklab = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) as [number, number, number];
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
  };
  const [a, b] = [oklab(first), oklab(second)];
  return 100 * Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
}

test("shared type and status tokens remain readable and distinct from the brand in both themes", async () => {
  const css = await readFile(new URL("../src/public/styles.css", import.meta.url), "utf8");
  const light = tokens(css, ":root {"), dark = tokens(css, ':root[data-theme="dark"] {');
  for (const [name, size] of Object.entries({ xs: "11px", sm: "12.5px", md: "14px", lg: "20px", figure: "26px" })) {
    assert.equal(light[`--fs-${name}`], size, name);
  }
  assert.equal(light["--focus"], "var(--coral)");
  for (const [theme, overrides] of [["light", light], ["dark", dark]] as const) {
    for (const name of ["--danger", "--warn", "--warn-text", "--ok"]) assert.match(overrides[name]!, /^#[0-9a-f]{6}$/i, `${theme}: ${name}`);
    const palette = { ...light, ...overrides };
    for (const foreground of ["--danger", "--warn-text"]) for (const background of ["--surface", "--bg"]) {
      const ratio = contrast(palette[foreground]!, palette[background]!);
      assert.ok(ratio >= 4.5, `${theme}: ${foreground} on ${background} = ${ratio.toFixed(2)}:1`);
    }
    assert.ok(deltaE(palette["--danger"]!, palette["--coral"]!) >= (theme === "light" ? 15 : 10), `${theme}: danger must be distinct from coral`);
  }
});

// Flat rule bodies also capture the rules nested in media queries. Comments cannot be selectors or declarations.
function rules(css: string) {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((match) => ({ selector: match[1]!.trim(), body: match[2]! }));
}

test("every stylesheet uses the shared font scale, apart from boxed mark glyphs", async () => {
  for (const [index, css] of (await Promise.all(styles.map(readCss))).entries()) {
    for (const { selector, body } of rules(css)) {
      if (/\.mark\b/.test(selector)) continue;
      for (const match of body.matchAll(/(?:^|;)\s*(font-size|font):\s*([^;]+)/g)) {
        const value = match[2]!.trim(), label = `${styles[index]} ${selector}: ${match[1]}: ${value}`;
        if (value === "inherit") continue; // Inherit carries the parent's tokenized size.
        assert.match(value, /var\(--fs-(?:xs|sm|md|lg|figure)\)/, label);
        assert.doesNotMatch(value, /\d*\.?\d+(?:px|rem|em|vh|%)/, label.replace(value, "literal size"));
      }
    }
  }
});

test("focus rings use one colour and panels have no decorative left stripes", async () => {
  for (const [index, css] of (await Promise.all(styles.map(readCss))).entries()) {
    for (const { selector, body } of rules(css)) {
      for (const match of body.matchAll(/(?:^|;)\s*outline:\s*([^;]+)/g)) {
        const value = match[1]!.trim();
        if (value !== "none") assert.match(value, /^\S+\s+solid\s+var\(--focus\)$/, `${styles[index]} ${selector}: ${value}`);
      }
      for (const match of body.matchAll(/(?:^|;)\s*border-left:\s*([\d.]+)px\b([^;]*)/g)) {
        if (/\btransparent\b/.test(match[2]!)) continue; // tooltip arrows are drawn with transparent borders
        assert.ok(Number(match[1]) < 3, `${styles[index]} ${selector}: left stripe`);
      }
      assert.ok(!/\.kpi\b[^,]*::before/.test(selector), `${styles[index]} ${selector}: KPI stripe`);
    }
  }
});

test("visually hidden text in coverage badges and tables cannot widen the page", async () => {
  // `.sr-only` is absolutely positioned; without a positioned ancestor inside the table's scroll area it escapes the
  // overflow clip and lets a 390px page scroll sideways (seen with the fleet table's coverage badges).
  const css = await readCss("styles.css");
  for (const selector of [".table-wrap", ".coverage"]) {
    const rule = rules(css).find((entry) => entry.selector === selector);
    assert.ok(rule, selector);
    assert.match(rule.body, /(?:^|;)\s*position:\s*relative\s*;/, `${selector} must be positioned`);
  }
});
