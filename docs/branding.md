# Branding and renaming

`session-analytics` is a descriptive working name. The product identity is concentrated in a few places so it can be renamed without breaking running dashboards, saved settings, or callers that parse the output.

## Brand assets

| File | Use |
| --- | --- |
| `assets/logo.svg` | The mark: a top-level session span with two sub-agent spans branching from it, on an ink tile. |
| `assets/logo.png` | 512 × 512 render of the mark. |
| `assets/logo-wordmark.svg` | Mark and wordmark for light backgrounds. |
| `assets/logo-wordmark-dark.svg` | Mark and wordmark for dark backgrounds. |
| `assets/social-preview.svg`, `.png` | 1280 × 640 repository social preview (upload the PNG in the GitHub repository settings). |
| `src/public/favicon.svg` | Dashboard favicon; the session-span mark in neutral ink tones. |
| Desktop `assets/screenshot-*.webp` | README screenshots in light and dark pairs (`-dark` suffix), rendered from the synthetic demo only at 1280 CSS pixels, comfortable density, as lossless WebP. |
| `assets/screenshot-mobile.webp`, `assets/screenshot-mobile-dark.webp` | Synthetic mobile Summary at 375 × 812 CSS pixels, compact density. Capture sources and regeneration commands are in [screenshot provenance](../assets/SCREENSHOTS.md). |

The wordmarks use a system font stack (`ui-sans-serif, -apple-system, Segoe UI, Helvetica Neue, Helvetica, Arial, sans-serif`) at weight 600, with `textLength` set so wider fallback fonts compress instead of clipping.

The dashboard follows Fluxary OS’s [design language](https://github.com/rokas-tarasevicius/fluxary-os/blob/d96e453ffb9ae8bd300e926db8fc61ec9c185e95/docs/decisions/2026-10-12-design-language.md): warm neutral surfaces, ink controls, opaque chrome, hairline borders and locally bundled Geist typography. At desktop widths of 1200px and above, Summary places its daily chart and provider breakdown beside a continuous 260px totals rail. Narrower screens retain totals-first reading order. Analytical sections sit on an open canvas with dividing lines; dialogs, controls and the totals rail retain surface boundaries.

The dashboard mark, favicon, controls and heatmap use a warm ink scale. Provider and model charts retain identity colours so series remain distinguishable. Exported repository logos and social-preview assets retain their original palette. Dashboard type is Geist (text) and Geist Mono (figures and identifiers), both bundled under the OFL.

| Role | Light | Dark |
| --- | --- | --- |
| Page | `#fbfbfa` | `#141413` |
| Sidebar | `#f6f6f4` | `#181817` |
| Surface | `#ffffff` | `#1d1d1b` |
| Secondary surface | `#efefec` | `#2a2a27` |
| Border | `#e7e7e4` | `#2f2f2d` |
| Ink | `#18181b` | `#ececea` |
| Secondary text | `#4f4f55` | `#b3b3ad` |
| Small captions | `#696970` | `#979791` |
| Heatmap, empty to highest | `#efefec` → `#28282a` | `#222220` → `#ececea` |

### Status and typography

Status always accompanies an icon or dot and text. Normal and warning states use ink and secondary text; red is reserved for errors (`#b3261e` light / `#ff6b6b` dark). Banners use subtle surface and border mixes. Panels have no ambient shadow; floating dialogs and menus use one restrained shadow level. Headers and dialogs are opaque, without backdrop blur.

The shared type roles are `--fs-caps` 11px (mono uppercase labels), `--fs-xs` 12px (notes, legends, deltas and coverage), `--fs-sm` 13px (body and tables), `--fs-md` 14px (controls), `--fs-title` 15px (panel titles), `--fs-h1` 18px (view and dialog titles), `--fs-lg` 20px (secondary figures) and `--fs-figure` 26px (KPI figures). Comfortable density uses explicit values of 11.5 / 12.5 / 13.5 / 15 / 16 / 19 / 21 / 28px in the same order. Figures do not change with viewport width, apart from the existing small-screen KPI size. Geist Mono is for figures and identifiers, plus uppercase labels and table headers; `.caps` shares `--track-caps: .06em`. Sentences use Geist Sans, with tabular numerals where they contain numbers. Boxed provider marks use an 18px tile with 10px text. Coverage fractions are plain muted text; unavailable reasons and range adjustments are visible, and stale-snapshot reasons appear in the warning banner.

Every focus ring uses `--focus`, which resolves to neutral `#71717a` in light and `#a1a19b` in dark: one global 2px ring with a 2px offset, plus chip and checkbox carriers and an inset ring for clipped Tools cells. These stronger focus steps provide at least 3:1 contrast on each working surface; body and caption text retain at least 4.5:1. Focus never changes a control's corners. Unchecked chips keep readable `--text-2`, a solid `--line` border, a hollow dot and a 45% mark. Repository row links, footer links and the rate-source summary have at least 24px targets; touch controls retain their larger targets.

Geometry tokens are `--radius` 12px for contained surfaces, `--radius-sm` 7px for controls, `--radius-md` 9px for intermediate surfaces, `--radius-xs` 4px, `--radius-lg` 12px for dialogs and the totals rail, `--radius-bar` 3px for bars and small swatches, `--radius-line` 2px for tiny line swatches, `--radius-pill` 99px for pills and `--radius-round` 50% for dots. Analytical panels and individual metrics have square section dividers without surrounding boxes. The logo uses `--radius`; its dark tile uses `--surface-3` and `--line-strong`. Compact control and row sizes use `--control` 32px and `--row` 34px; comfortable rows are 40px. Loading placeholders share one `.shimmer` gradient. Print uses static navigation and headers, expands table wrappers and hides top-bar actions and export controls. Reduced motion disables animations; refresh status remains visible as “Refreshing…”.

Chart grid lines use `--grid-line`: `var(--line)` in light and `var(--line-strong)` in dark. Trend areas use `--area-alpha`: .1 in light and .18 in dark. Borders retain their existing theme tokens.

### Provider and chart colours

Provider/model identity comes from `src/public/chart-colors.js` and matching `--provider-*` CSS tokens. A regression test checks both theme palettes against the CSS.

| Provider | Light | Dark |
| --- | --- | --- |
| OpenAI / Codex / GPT | `#5c5c59` | `#9a9a96` |
| Anthropic / Claude | `#c96442` | `#d8683f` |
| Cursor | `#008aa0` | `#13a0b3` |
| GitHub Copilot | `#8250df` | `#9672ea` |
| OpenCode | `#a8820d` | `#b98a14` |
| Google Gemini | `#3a7be0` | `#4f8ae8` |
| Unknown / unsupported | `#90908a` | `#80807a` |
| Neutral single series (repositories, tools, delegation) | `#4f4f55` | `#b3b3ad` |

OpenAI greys deliberately depart from the chroma floor to preserve brand identity; series are always labelled. Cursor's monochrome mark uses cyan-teal in charts to distinguish it from OpenAI.

Model shades belong to the family, never its rank or value: flagship tier 0, standard tier 1, named/Codex variants tier 2 (unknown named families use a stable tier 1/2 hash), light tier 3. Opus, Sonnet and Haiku always use tiers 0, 1 and 3. Light tiers use Oklab mixes of base 72% + black, base, base 72% + white, base 50% + white. Dark tiers use base 70% + white, base, base 72% + black, base 52% + black. Claude and GPT have explicit shades; their dark tier-3 shades are lifted above the generic mix to keep at least 3:1 contrast on the card surface:

| Family | Theme | Tier 0 | Tier 1 | Tier 2 | Tier 3 |
| --- | --- | --- | --- | --- | --- |
| Claude | Light | `#9a4127` | `#c96442` | `#df8a66` | `#ecb49a` |
| Claude | Dark | `#f2a887` | `#d8683f` | `#ae4f2f` | `#a65237` |
| GPT / Codex | Light | `#262624` | `#5c5c59` | `#8a8a86` | `#b5b5b0` |
| GPT / Codex | Dark | `#e6e6e1` | `#9a9a96` | `#73736f` | `#6a6a66` |

Velocity's non-provider groups (repository, execution kind, effort) use the `--category-0..3` ramp from `src/public/chart-colors.js`: green `#008719`, orchid `#dc6bc4`, lime `#9ac32b`, plum `#8a0e82` in light; `#357101`, `#df58aa`, `#56aa14`, `#9a4680` in dark. Greens and orchids are the hue families no provider uses. Every slot is at least OKLab ΔE 15 from every other slot and from every provider hue in both themes (all pairs, not only adjacent ones), and both themes pass the data-viz validator. Light lime is below 3:1 contrast on white, so these charts always carry a labelled legend and a text equivalent. A greens-only ramp was not used: within the dark-theme lightness band, four greens cannot get further apart than ΔE 9. Series past the fourth slot repeat the ramp with texture (stacked) or dashes (lines). Execution kinds and effort levels keep fixed slots, so their colours do not change with filters. Other and unknown series use the neutral `--provider-unknown` grey, which has at least 3:1 contrast on `--surface` in both themes. `--heat-*` uses a neutral intensity ramp for the activity heatmap. The provider hues pass the data-viz validator's adjacent-pair checks in provider order (worst adjacent CVD ΔE 10.7 light, 9.9 dark); with all six on screen at once, Gemini blue and Copilot purple are close under deuteranopia, so provider charts always carry a labelled legend. Cost components use shades of the provider hue (or neutral ink for repositories), with stripes for provider-reported value. Legends use readable neutral text and support pointer highlighting; they are list items, not tab stops (charts have their own keyboard readout). Cost, model and tool bars share the maximum across their panel, with no minimum fill width.

### Regenerating images

```bash
rsvg-convert -w 512 -h 512 assets/logo.svg -o assets/logo.png
rsvg-convert -w 1280 -h 640 assets/social-preview.svg -o assets/social-preview.png
```

Screenshots come from the demo dataset only. In one terminal, start `npm run demo -- --no-open`; in another, run `node scripts/screenshots.ts --url http://127.0.0.1:4175`. The script requires Chrome and `cwebp`, captures desktop views at 1280 CSS pixels and 2x scale in comfortable density, and writes lossless light/dark WebP pairs to `assets/`. The `--only mobile` capture uses 375 × 812 CSS pixels, 2x scale and compact density. Use `--only NAME` for one capture or `--out DIR` for a review artifact directory. See [screenshot provenance](../assets/SCREENSHOTS.md) for the source and capture settings. Never point it at a dashboard reading real history.

## Renaming the product

1. **`src/brand.ts`**: `brand.name` (display name in help text, logs, and the dashboard) and `brand.command` (the command name shown in help).
2. **`package.json`**: `name`, `description`, the `bin` key, and the `repository`, `homepage`, and `bugs` URLs. Rename `bin/session-analytics.ts` if the file name should match, and update the `start`, `report`, and `demo` scripts.
3. **Dashboard**: the `<title>`, the wordmark text (`Session <b>Analytics</b>`), and the wordmark's `aria-label` in `src/public/index.html`.
4. **Agent skill**: the directory `skills/session-analytics/`, its `name` and command in `SKILL.md`, and `skills/session-analytics/agents/openai.yaml`. Users who symlinked the skill need to update the link.
5. **Assets**: edit the SVG text in both wordmarks and the social preview, regenerate the PNGs, and replace `src/public/favicon.svg` if the mark changes.
6. **Documentation**: README badges and links, `SECURITY.md` and `CODE_OF_CONDUCT.md` links, `.github/ISSUE_TEMPLATE/config.yml`, and the clone URL.
7. **Tests**: `test/cli.test.ts` and `test/contract.test.ts` assert the command name, help text, and skill name; update them in the same change.

When the repository moves to a new owner or name, GitHub keeps redirects, issues, and pull requests.

## Identifiers that stay neutral

These do not follow the brand. Changing them breaks something that already depends on them.

| Identifier | Where | Why it stays |
| --- | --- | --- |
| Health service ID `session-analytics` | `serviceId` in `src/brand.ts`, returned by `/api/health` | A new launch checks it to decide whether the process on the port is a compatible dashboard it can reuse. |
| `localStorage` keys `session-analytics-view` and `session-analytics-theme` | `src/public/app.js` | Renaming them silently resets every user's saved view and theme. |
| JSON field names | `src/types.ts` | Scripts, the agent skill, and future MCP clients parse the snapshot; renames need a versioned schema change. |
| Session key and repository ID derivation | `src/analyzer.ts` | Keys must match across snapshots for comparisons. This includes the fixed grouping root used for ephemeral sessions, which is part of that group's repository ID hash. |
| `SESSION_ANALYTICS_*` environment variables | `src/options.ts` | Existing shell profiles and run scripts set them. If a new prefix is added, keep these as aliases. |

The shipped MCP tool names (`budget_status`, `tool_stats` and the other tools), exported `gen_ai.*` attributes and JSON `schemaVersion` follow the same rule. The current data directory uses `session-analytics`; any future rename needs an explicit migration so the existing index and pricing history remain usable.
