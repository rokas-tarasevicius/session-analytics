import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
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
  for (const [name, size] of Object.entries({ caps: "11px", xs: "12px", sm: "13px", md: "14px", title: "15px", h1: "18px", lg: "20px", figure: "26px" })) {
    assert.equal(light[`--fs-${name}`], size, name);
  }
  for (const [theme, overrides] of [["light", light], ["dark", dark]] as const) {
    for (const name of ["--danger", "--warn", "--warn-text", "--ok"]) assert.match(overrides[name]!, /^#[0-9a-f]{6}$/i, `${theme}: ${name}`);
    const palette = { ...light, ...overrides };
    // The Fluxary-style neutral focus ring must remain visible on every working surface.
    for (const background of ["--bg", "--surface", "--surface-2", "--sidebar-surface"]) {
      assert.ok(contrast(palette["--focus"]!, palette[background]!) >= 3, `${theme}: focus on ${background}`);
      for (const foreground of ["--text", "--text-2", "--muted"]) {
        assert.ok(contrast(palette[foreground]!, palette[background]!) >= 4.5, `${theme}: ${foreground} on ${background}`);
      }
    }
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
      if (selector.startsWith(":root")) continue;
      if (selector === ".pill.mark") { assert.match(body, /font: 600 10px\/1 var\(--font-mono\)/); continue; }
      for (const match of body.matchAll(/(?:^|;)\s*(font-size|font):\s*([^;]+)/g)) {
        const value = match[2]!.trim(), label = `${styles[index]} ${selector}: ${match[1]}: ${value}`;
        if (value === "inherit") continue; // Inherit carries the parent's tokenized size.
        assert.match(value, /var\(--fs-(?:caps|xs|sm|md|title|h1|lg|figure)\)/, label);
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
      assert.doesNotMatch(body, /(?:^|;)\s*border-left-color:/, `${styles[index]} ${selector}: selection stripe`);
      for (const shadow of body.matchAll(/\binset\s+(-?[\d.]+)(?:px)?\s+(-?[\d.]+)(?:px)?(?:\s+(-?[\d.]+)(?:px)?)?(?:\s+(-?[\d.]+)(?:px)?)?/g)) {
        const [x, y, blur, spread] = shadow.slice(1).map((value) => Number(value ?? 0));
        if (blur === 0) assert.ok(Math.max(Math.abs(x!), Math.abs(y!), Math.abs(spread!)) <= 2, `${styles[index]} ${selector}: inset stripe`);
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

test("fleet table details use tooltips and accessible names instead of sub-lines", async () => {
  const app = await readFile(new URL("../src/public/app.js", import.meta.url), "utf8");
  const cells = app.slice(app.indexOf("function renderRepositoryTable("), app.indexOf("function renderWarnings("));
  assert.doesNotMatch(cells, /node\("small"/);
  assert.match(cells, /sessionsCell\.title = executionBreakdown\(summary\)/);
  assert.match(cells, /repositoryButton\.title = repositoryDetails/);
  assert.match(cells, /row\.setAttribute\("aria-label",.*repositoryDetails.*executionBreakdown\(summary\)/);
  const css = await readCss("styles.css");
  const repository = rules(css).find(({ selector }) => selector === "#repository-comparison .row-link");
  assert.ok(repository);
  assert.match(repository.body, /text-overflow:\s*ellipsis/);
  assert.match(repository.body, /overflow:\s*hidden/);
  const tables = rules(css).find(({ selector }) => selector === "table");
  assert.ok(tables); assert.doesNotMatch(tables.body, /min-width/);
  assert.match(css, /#repository-comparison table\s*\{\s*min-width:\s*880px/);
  assert.match(css, /@media \(max-width: 1279px\)[\s\S]*?#repository-comparison :is\(th, td\):first-child\s*\{[^}]*position:\s*sticky;[^}]*background:\s*var\(--surface\)/);
  assert.match(css, /#repository-comparison thead th:first-child\s*\{\s*z-index:\s*3/);
});

test("table wrappers share CSS-only local scroll shadows", async () => {
  const rule = rules(await readCss("styles.css")).find(({ selector }) => selector === ".table-wrap");
  assert.ok(rule);
  assert.match(rule.body, /background-attachment:\s*local,\s*local,\s*scroll,\s*scroll/);
  assert.match(rule.body, /linear-gradient\(to right, var\(--surface\)/);
  assert.match(rule.body, /linear-gradient\(to left, var\(--surface\)/);
  assert.match(rule.body, /radial-gradient\(farthest-side at 0 50%/);
  assert.match(rule.body, /radial-gradient\(farthest-side at 100% 50%/);
});

test("daily usage chips have a separate wrapping row with a six-pixel gap", async () => {
  const html = await readFile(new URL("../src/public/index.html", import.meta.url), "utf8");
  assert.match(html, /<header class="daily-usage-header"><div><h2>Daily usage value<\/h2>/);
  const cssRules = rules(await readCss("styles.css"));
  assert.match(cssRules.find(({ selector }) => selector === ".panel > .daily-usage-header")!.body, /flex-direction:\s*column/);
  const chips = cssRules.find(({ selector }) => selector === ".daily-usage-header .provider-key");
  assert.ok(chips); assert.match(chips.body, /flex-wrap:\s*wrap/); assert.match(chips.body, /gap:\s*6px/);
});

test("all KPI grids share responsive columns without per-view column overrides", async () => {
  const shared = await readCss("styles.css");
  assert.match(shared, /\.kpi-grid\s*\{[^}]*grid-template-columns:\s*repeat\(var\(--kpi-columns, 4\), minmax\(0, 1fr\)\)/);
  assert.match(shared, /@media \(max-width: 1000px\)[\s\S]*?\.kpi-grid\s*\{\s*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  for (const file of ["pricing.css", "velocity.css"]) {
    const css = await readCss(file);
    for (const { selector, body } of rules(css)) {
      if (/\.kpi-grid|\.velocity-(?:lead|totals)/.test(selector)) assert.doesNotMatch(body, /grid-template-columns/, `${file}: ${selector}`);
    }
  }
  assert.doesNotMatch(await readCss("pricing.css"), /@media\s*\(max-width:\s*520px\)/);
});

test("dashboard formatting is centralized in format.js", async () => {
  const root = new URL("../src/public/", import.meta.url);
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || entry.name === "format.js") continue;
    const file = join(entry.parentPath, entry.name);
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /new\s+Intl\.|\btoLocaleString\s*\(/, file);
  }
});

test("daily usage legend uses two list columns so provider values cannot orphan", async () => {
  const cssRules = rules(await readCss("styles.css"));
  const list = cssRules.find(({ selector }) => selector === '#daily-spend .chart-legend[data-layout="list"]');
  assert.ok(list);
  assert.match(list.body, /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  const item = cssRules.find(({ selector }) => selector === '#daily-spend .chart-legend[data-layout="list"] .chart-legend-item');
  assert.ok(item);
  assert.match(item.body, /grid-template-columns:\s*16px minmax\(0, 1fr\) auto/);
});

test("title roles and fixed figures use the explicit compact and comfortable type scales", async () => {
  const css = await readCss("styles.css"), cssRules = rules(css);
  const comfortable = tokens(css, ':root[data-density="comfortable"] {');
  for (const [name, size] of Object.entries({ caps: "11.5px", xs: "12.5px", sm: "13.5px", md: "15px", title: "16px", h1: "19px", lg: "21px", figure: "28px" })) assert.equal(comfortable[`--fs-${name}`], size);
  for (const [selector, role] of [[".topbar-title h1", "h1"], [".help h2", "h1"], ["h2", "title"], [".panel > header h3, .panel > h3", "title"], [".kpi strong", "figure"]]) {
    const body = cssRules.find((rule) => rule.selector === selector)!.body;
    assert.ok(body.includes(`var(--fs-${role})`), selector); assert.doesNotMatch(body, /clamp\(/);
  }
  assert.match(await readCss("interop.css"), /#shared-snapshot h1\s*\{[^}]*font-size: var\(--fs-h1\)/);
});

test("uppercase labels and loading placeholders share one caps and shimmer rule", async () => {
  const css = await readCss("styles.css"), cssRules = rules(css);
  assert.equal(tokens(css, ":root {")["--track-caps"], ".06em");
  const caps = cssRules.filter(({ body }) => /text-transform:\s*uppercase/.test(body));
  assert.equal(caps.length, 1);
  assert.ok(caps[0]!.selector.startsWith(".caps,"));
  for (const selector of [".nav-heading", ".kicker", "thead th", ".pill:not(.mark)", ".evidence-pill", ".palette-group", ".help h3", ".field-label"]) assert.ok(caps[0]!.selector.includes(selector), selector);
  assert.match(caps[0]!.body, /var\(--fs-caps\)/); assert.match(caps[0]!.body, /var\(--track-caps\)/);
  const shimmer = cssRules.filter(({ body }) => /animation:\s*shimmer/.test(body));
  assert.equal(shimmer.length, 1); assert.ok(shimmer[0]!.selector.startsWith(".shimmer,"));
  assert.equal((css.match(/linear-gradient\(90deg/g) ?? []).length, 2, "one loading gradient and the existing dashed legend swatch");
});

test("base component rules and responsive width blocks are consolidated", async () => {
  const css = await readCss("styles.css"), base = css.slice(0, css.indexOf("/* ---------------------------------------------------------------- responsive */"));
  for (const selector of ["main > footer", ".compact-metrics", ".help", ".field", ".kpi", "tbody tr"]) assert.equal(rules(base).filter((rule) => rule.selector === selector).length, 1, selector);
  for (const width of [1120, 760, 520]) assert.equal((css.match(new RegExp(`@media \\(max-width: ${width}px\\)`, "g")) ?? []).length, 1, String(width));
  assert.doesNotMatch(css, /max-width:\s*1240px/);
  assert.match(rules(base).find(({ selector }) => selector === "tbody tr")!.body, /cursor:\s*default/);
  assert.match(rules(base).find(({ selector }) => selector === 'tbody tr[role="link"], tbody tr[data-row-link]')!.body, /cursor:\s*pointer/);
});

test("focus has exactly one global ring and the three allowed carriers", async () => {
  const expected = new Map([
    ["styles.css :focus-visible", "2px"],
    ["styles.css .chip:has(input:focus-visible)", "2px"],
    ["styles.css .check:has(input:focus-visible)", "2px"],
    ["tools.css #tools-view .tools-select:focus-visible, #tools-view .tools-column:focus-visible", "-2px"],
  ]);
  const found = new Map<string, string>();
  for (const file of styles) for (const { selector, body } of rules(await readCss(file))) {
    if (!selector.includes(":focus-visible")) continue;
    assert.match(body, /outline:\s*2px solid var\(--focus\)/);
    assert.doesNotMatch(body, /border-radius/);
    found.set(`${file} ${selector}`, body.match(/outline-offset:\s*([^;]+)/)![1]!.trim());
  }
  assert.deepEqual(found, expected);
});

test("rounded geometry uses tokens and no control advertises hover-only help", async () => {
  for (const file of styles) for (const { selector, body } of rules(await readCss(file))) {
    assert.doesNotMatch(body, /cursor:\s*help/, `${file}: ${selector}`);
    if (selector.startsWith(":root")) continue;
    for (const match of body.matchAll(/(?:^|;)\s*border(?:-(?:top|bottom)-(?:left|right))?-radius:\s*([^;]+)/g)) {
      assert.doesNotMatch(match[1]!, /[\d.]+(?:px|rem|em|%)/, `${file}: ${selector}`);
      assert.match(match[1]!, /^(?:var\(--radius[\w-]*\)|0)(?:\s+(?:var\(--radius[\w-]*\)|0))*$/);
    }
  }
});

test("chart contrast and theme-scoped grid and area tokens meet their surface roles", async () => {
  const css = await readCss("styles.css"), light = tokens(css, ":root {"), dark = tokens(css, ':root[data-theme="dark"] {');
  for (const [name, theme] of [["light", light], ["dark", dark]] as const) {
    const palette = { ...light, ...theme };
    for (const token of ["--provider-unknown", ...(name === "dark" ? ["--provider-codex-3", "--provider-claude-3"] : [])]) {
      const ratio = contrast(palette[token]!, palette["--surface"]!);
      assert.ok(ratio >= 3, `${name}: ${token} = ${ratio.toFixed(2)}:1`);
    }
  }
  assert.equal(light["--grid-line"], "var(--line)"); assert.equal(dark["--grid-line"], "var(--line-strong)");
  assert.equal(light["--area-alpha"], ".1"); assert.equal(dark["--area-alpha"], ".18");
  assert.match(css, /\.grid-line\s*\{\s*stroke:\s*var\(--grid-line\)/);
  assert.match(css, /\.trend-area\s*\{[^}]*fill-opacity:\s*var\(--area-alpha\)/);
  assert.match(css, /\.logo-tile\s*\{\s*fill:\s*var\(--surface-3\);\s*stroke:\s*var\(--line-strong\)/);
});

test("unchecked chips keep readable text, solid borders and distinct state marks", async () => {
  const cssRules = rules(await readCss("styles.css"));
  const body = cssRules.find(({ selector }) => selector === ".chip:has(input:not(:checked))")!.body;
  assert.match(body, /color:\s*var\(--text-2\)/); assert.match(body, /border-color:\s*var\(--line\)/); assert.doesNotMatch(body, /dashed/);
  assert.match(cssRules.find(({ selector }) => selector === ".chip:has(input:not(:checked))::before")!.body, /background:\s*transparent;.*inset/);
  assert.match(cssRules.find(({ selector }) => selector === ".chip:has(input:not(:checked)) img")!.body, /opacity:\s*\.45/);
});

test("marks, inline targets and coverage fractions use their readable shared styles", async () => {
  const css = await readCss("styles.css"), cssRules = rules(css);
  const mark = cssRules.find(({ selector }) => selector === ".pill.mark")!.body;
  assert.match(mark, /width:\s*18px;\s*height:\s*18px/); assert.match(mark, /font:\s*600 10px\/1/);
  for (const selector of [".row-link", "main > footer a", ".rate-links > summary"]) {
    const body = cssRules.find((rule) => rule.selector === selector)!.body;
    assert.match(body, /min-height:\s*24px/, selector);
    if (selector === ".row-link") assert.match(body, /padding:\s*3px 0/);
    else { assert.match(body, /display:\s*inline-block/); assert.match(body, /line-height:\s*24px/); }
  }
  const coverage = cssRules.find(({ selector }) => selector === ".coverage")!.body;
  assert.match(coverage, /color:\s*var\(--muted\)/); assert.doesNotMatch(coverage, /(?:background|border|padding|height):/);
  assert.doesNotMatch(await readFile(new URL("../src/public/index.html", import.meta.url), "utf8"), /hover a badge for coverage/);
});

test("print expands tables and removes sticky chrome and export actions", async () => {
  const css = await readCss("styles.css"), print = css.slice(css.indexOf("@media print {"));
  assert.match(print, /\.sidebar\s*\{[^}]*position:\s*static/);
  assert.match(print, /\.topbar\s*\{[^}]*position:\s*static/);
  assert.match(print, /\.table-wrap[^}]*max-height:\s*none/);
  assert.match(print, /\.topbar-actions, \.export-menu\s*\{\s*display:\s*none/);
});

test("reduced motion stops the spinner and pulse and narrow screens retain loading text", async () => {
  const css = await readCss("styles.css");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\*, \*::before, \*::after\s*\{\s*animation:\s*none !important/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.status\[data-state="loading"\] #sync-label\s*\{\s*display:\s*inline-block/);
});

test("narrow four-column KPI rows give the fixed-size figure the full card width", async () => {
  const css = await readCss("styles.css");
  const block = /@media \(max-width: 1320px\) \{([\s\S]*?)\n\}/.exec(css)![1]!;
  assert.match(block, /\.kpi \{ grid-template-areas: "label label" "value value" "coverage spark" "delta spark" "note note"; \}/);
  assert.match(block, /\.kpi \.spark \{ width: 64px; \}/);
});

test("Summary defaults to three KPI columns before responsive overrides and Velocity inspection uses a two-column grid", async () => {
  const css = await readCss("styles.css"), velocity = await readCss("velocity.css");
  assert.match(rules(css).find(({ selector }) => selector === ".summary-metrics")!.body, /--kpi-columns:\s*3/);
  assert.match(rules(velocity).find(({ selector }) => selector === ".velocity-inspection")!.body, /display:\s*grid/);
  assert.match(rules(velocity).find(({ selector }) => selector === ".velocity-inspection")!.body, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(rules(velocity).find(({ selector }) => selector === ".velocity-inspection > strong")!.body, /grid-column:\s*1\s*\/\s*-1/);
});


test("Activity heatmap scrolls inside its panel without widening the view", async () => {
  const html = await readFile(new URL("../src/public/index.html", import.meta.url), "utf8");
  assert.match(html, /class="activity-heatmap-scroll"[^>]*role="region"[^>]*tabindex="0"><div class="activity-heatmap/);
  const cssRules = rules(await readCss("styles.css"));
  assert.match(cssRules.find(({ selector }) => selector === ".activity-panel")!.body, /min-width:\s*0/);
  assert.match(cssRules.find(({ selector }) => selector === ".activity-heatmap-scroll")!.body, /max-width:\s*100%;\s*overflow-x:\s*auto/);
});


test("phone legends keep provider words intact in a single list column", async () => {
  const css = await readCss("styles.css");
  const label = rules(css).find(({ selector }) => selector === ".chart-legend-label")!;
  assert.match(label.body, /overflow-wrap:\s*normal/);
  assert.doesNotMatch(label.body, /break-word|anywhere|break-all/);
  assert.match(css, /@media \(max-width: 440px\)\s*\{\s*#daily-spend \.chart-legend\[data-layout="list"\]\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/);
});


test("Velocity mover names keep their full identity inside the table scroll area", async () => {
  const cssRules = rules(await readCss("velocity.css"));
  const name = cssRules.find(({ selector }) => selector === ".velocity-movers td:nth-child(2)")!;
  assert.match(name.body, /min-width:\s*20ch/);
  assert.match(name.body, /white-space:\s*nowrap/);
});


test("tool names wrap only at separators and small baseline stays together", async () => {
  const cssRules = rules(await readCss("tools.css"));
  const name = cssRules.find(({ selector }) => selector === "#tools-view .tools-select")!;
  assert.match(name.body, /overflow-wrap:\s*normal/);
  assert.match(name.body, /word-break:\s*normal/);
  assert.match(cssRules.find(({ selector }) => selector === "#tools-view .tools-change-detail")!.body, /white-space:\s*nowrap/);
});


test("Costs reserve a separate fixed badge slot so all amounts align", async () => {
  const css = await readCss("styles.css");
  const desktop = css.slice(css.indexOf("@media (min-width: 761px)"));
  assert.match(desktop, /\.cost-stack-row > strong:last-child, \.cost-model-row > strong\s*\{[^}]*grid-template-columns:\s*auto 7rem/);
  assert.match(desktop, /> \.coverage\s*\{[^}]*justify-self:\s*start;[^}]*margin-left:\s*0/);
});


test("selected sidebar repositories preserve the unselected label width", async () => {
  const cssRules = rules(await readCss("styles.css"));
  const selected = cssRules.find(({ selector }) => selector === '.repo-row[aria-pressed="true"]')!;
  assert.match(selected.body, /box-shadow:\s*inset 0 0 0 1px/);
  assert.doesNotMatch(selected.body, /(?:^|;)\s*(?:border(?:-width)?|padding(?:-inline)?|gap):/);
});


test("snapshot metadata wraps with spacing and no dangling separator", async () => {
  const html = await readFile(new URL("../src/public/index.html", import.meta.url), "utf8");
  assert.match(html, /id="generated-at">[^<]*<\/span><span id="rate-card-date">/);
  const rule = rules(await readCss("styles.css")).find(({ selector }) => selector === ".snapshot-meta")!;
  assert.match(rule.body, /flex-wrap:\s*wrap/);
  assert.match(rule.body, /gap:\s*6px 12px/);
});


test("tool profile metrics fit readable columns without a fixed three-column orphan", async () => {
  const css = await readCss("tools.css");
  const rule = rules(css).find(({ selector }) => selector === "#tools-view .tools-profile-stats")!;
  assert.match(rule.body, /grid-template-columns:\s*repeat\(auto-fit, minmax\(100px, 1fr\)\)/);
  assert.equal(rules(css).filter(({ selector }) => selector === "#tools-view .tools-profile-stats").length, 1);
});


test("checkbox controls retain a full control-height label and a visible box", async () => {
  const cssRules = rules(await readCss("styles.css"));
  assert.match(cssRules.find(({ selector }) => selector === ".check")!.body, /min-height:\s*var\(--control\)/);
  assert.match(cssRules.find(({ selector }) => selector === ".check input")!.body, /width:\s*18px;\s*height:\s*18px;\s*flex-shrink:\s*0/);
});


test("export actions precede the collapsible scope and privacy explanation", async () => {
  const html = await readFile(new URL("../src/public/index.html", import.meta.url), "utf8");
  const menu = html.slice(html.indexOf('class="export-options"'), html.indexOf('</details>', html.indexOf('class="export-options"')));
  assert.ok(menu.indexOf('data-export="json"') < menu.indexOf('id="export-description"'));
  assert.match(menu, /<details class="export-includes"><summary>What’s included<\/summary><p id="export-description">/);
});
