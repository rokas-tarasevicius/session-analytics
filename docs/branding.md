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
| `src/public/favicon.svg` | Dashboard favicon; a copy of the mark without the title element. |
| `assets/screenshot-*.png` | Dashboard screenshots, rendered from the synthetic demo only. |

The wordmarks use a system font stack (`ui-sans-serif, -apple-system, Segoe UI, Helvetica Neue, Helvetica, Arial, sans-serif`) at weight 600, with `textLength` set so wider fallback fonts compress instead of clipping.

Palette, shared with the dashboard's light and dark themes. The exact logo hexes are used for UI accents (active states and focus rings); provider charts use the brand palette below; other categorical charts use the non-brand categorical ramp. Dashboard type is Geist (text) and Geist Mono (figures), both bundled under the OFL:

| Role | Color |
| --- | --- |
| Ink (tile, light-theme text) | `#181a16` |
| Paper (light background) | `#efeee7` |
| Coral (top-level span, accent) | `#d66b55`, text accent light `#a0412e` / dark `#ec8d79` |
| Sage (sub-agent span) | `#7eb7a7` |
| Ochre (sub-agent span) | `#d4aa70` |
| Connector | `#62665c` |
| Heatmap ramp (light) | `#eef2ef` to `#005742` (sage, light to dark) |
| Heatmap ramp (dark) | `#1a1c18` to `#7eddc0` (sage, dark to light) |
| Dark surfaces | page `#0e0f0d`, card `#151613`, raised `#1b1d19` / `#22241f`, border `#262823` |
| Light surfaces | page `#f4f4f1`, card `#ffffff`, raised `#f6f6f3` / `#ecece8`, border `#e4e4df` |

### Status and typography

Status colours are reserved for state and always accompany an icon and text; they never identify data series or the brand. Danger is `#b3124a` in light / `#ff6f9a` in dark; warning is `#b0712a` (text `#8a5a00`) in light / `#e0b67b` in dark; OK is `#1e7f5c` in light / `#6fc7a6` in dark. Banners use subtle surface and border mixes of these tokens.

The shared type scale is 11 / 12.5 / 14 / 20px, with 26px for figures; comfortable density steps it up to 11.5 / 13.5 / 15 / 21 / 28px. Geist Mono is for figures and identifiers, plus small uppercase eyebrow labels and table headers. Sentences use Geist Sans, with tabular numerals where they contain numbers. Every focus ring uses the single `--focus` token, which resolves to coral (`#d66b55`) in both themes.

### Provider and chart colours

Provider/model identity comes from `src/public/chart-colors.js` and matching `--provider-*` CSS tokens. A regression test checks both theme palettes against the CSS.

| Provider | Light | Dark |
| --- | --- | --- |
| OpenAI / Codex / GPT | `#5c5c59` | `#9a9a96` |
| Anthropic / Claude | `#c96442` | `#d8683f` |
| Cursor | `#008aa0` | `#13a0b3` |
| GitHub Copilot | `#8250df` | `#9672ea` |
| OpenCode | `#9c7a0a` | `#b98a14` |
| Google Gemini | `#3a7be0` | `#4f8ae8` |
| Unknown / unsupported, Other | `#858582` | `#6f7c7c` |
| Neutral single series (repositories, tools, delegation) | `#006855` | `#68bea8` |

OpenAI greys deliberately depart from the chroma floor to preserve brand identity; series are always labelled. Cursor's monochrome mark uses cyan-teal in charts to distinguish it from OpenAI.

Model and agent series are coloured by the provider that ran them (a Cursor row of a Claude model is Cursor teal, never Claude coral), in four shades per provider. Slot 0 is the brand colour; slots 1-3 step away from it in lightness with a small hue/chroma shift. Every shade is at least 3:1 against the chart track (`--surface-3`) and the surface in its theme, the shades of one provider are at least OKLab ΔE 8 apart (9-10 for most), and each provider's four shades pass the data-viz validator's ordinal checks against the track. The 3:1 floor is why light-theme shades run darker than before (the old lightest tiers were 1.5-1.7:1). A model's preferred slot is its family tier (flagship 0, standard 1, named/Codex variants 2, small 3; unknown named families hash to 1 or 2); the provider's most-preferred visible family takes slot 0, so every provider shows its brand colour (a lone Sonnet on Gemini CLI is Gemini blue), and every model visible in a chart gets its own slot (`modelSlots`), newest version first when two prefer the same one, so the shade follows the model id and the visible set, never its value or rank. A fifth model of one provider repeats a shade with a diagonal texture (bars, areas) or point markers (lines), never the same shade beside it. Dashes are reserved for the 7-day average.

| Provider | Theme | Slot 0 | Slot 1 | Slot 2 | Slot 3 |
| --- | --- | --- | --- | --- | --- |
| Claude | Light | `#c96442` | `#852404` | `#925436` | `#5a180b` |
| Claude | Dark | `#d8683f` | `#f59768` | `#fec5b4` | `#ac5946` |
| GPT / Codex | Light | `#5c5c59` | `#444441` | `#2d2d2a` | `#171715` |
| GPT / Codex | Dark | `#9a9a96` | `#b6b6b3` | `#d3d3d0` | `#efeeeb` |
| Cursor | Light | `#008aa0` | `#034b55` | `#276679` | `#013036` |
| Cursor | Dark | `#13a0b3` | `#68c2da` | `#a0e3eb` | `#2b838b` |
| Copilot | Light | `#8250df` | `#460299` | `#673f97` | `#2a0368` |
| Copilot | Dark | `#9672ea` | `#c39aff` | `#d3ccff` | `#7264bb` |
| OpenCode | Light | `#9c7a0a` | `#584101` | `#6f6024` | `#3b2901` |
| OpenCode | Dark | `#b98a14` | `#d3b55f` | `#f7d49c` | `#9a712d` |
| Gemini | Light | `#3a7be0` | `#014289` | `#415ca0` | `#002c57` |
| Gemini | Dark | `#4f8ae8` | `#8daefe` | `#b5d5ff` | `#3d75b5` |

Codex stays neutral, with steps darker (lighter in dark mode) than the Other/unknown grey, which is at least ΔE 10 from every Codex shade; the dark grey carries a slight cool tint to stay ΔE 15 from the plum category slot.

Velocity's non-provider groups (repository, execution kind, effort) use the `--category-0..3` ramp from `src/public/chart-colors.js`: green `#008719`, orchid `#dc6bc4`, lime `#9ac32b`, plum `#8a0e82` in light; `#357101`, `#df58aa`, `#56aa14`, `#9a4680` in dark. Greens and orchids are the hue families no provider uses. Every slot is at least OKLab ΔE 15 from every other slot and from every provider hue in both themes (all pairs, not only adjacent ones), and both themes pass the data-viz validator. Light lime is below 3:1 contrast on white, so these charts always carry a labelled legend and a text equivalent. A greens-only ramp was not used: within the dark-theme lightness band, four greens cannot get further apart than ΔE 9. Series past the fourth slot repeat the ramp with texture (stacked) or point markers (lines). Execution kinds and effort levels keep fixed slots, so their colours do not change with filters. Other and unknown series use the neutral `--provider-unknown` grey. `--heat-*` remains the sage ramp for the activity heatmap. The provider hues pass the data-viz validator's adjacent-pair checks in provider order (worst adjacent CVD ΔE 10.7 light, 9.9 dark); with all six on screen at once, Gemini blue and Copilot purple are close under deuteranopia, so provider charts always carry a labelled legend. Cost components use shades of the provider hue (or neutral sage for repositories), with stripes for provider-reported value. Legends use readable neutral text and support pointer highlighting; they are list items, not tab stops (charts have their own keyboard readout). Cost, model and tool bars share the maximum across their panel, with no minimum fill width.

### Regenerating images

```bash
rsvg-convert -w 512 -h 512 assets/logo.svg -o assets/logo.png
rsvg-convert -w 1280 -h 640 assets/social-preview.svg -o assets/social-preview.png
```

Screenshots come from the demo dataset only. Start it with `npm run demo -- --no-open`, then capture `http://127.0.0.1:4175` at 1440 × 1100 in a headless browser. Never capture a dashboard that is reading real history.

## Renaming the product

1. **`src/brand.ts`**: `brand.name` (display name in help text, logs, and the dashboard) and `brand.command` (the command name shown in help).
2. **`package.json`**: `name`, `description`, the `bin` key, and the `repository`, `homepage`, and `bugs` URLs. Rename `bin/session-analytics.ts` if the file name should match, and update the `start`, `report`, and `demo` scripts.
3. **Dashboard**: the `<title>`, the wordmark text (`SESSION <b>ANALYTICS</b>`), and the wordmark's `aria-label` in `src/public/index.html`.
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

Planned identifiers follow the same rule: MCP tool names will be generic (`budget_status`, `tool_stats`), telemetry attributes will use the standard `gen_ai.*` namespace, and the JSON output will carry a `schemaVersion`. The data directory will be brand-derived, with a one-time migration when the brand changes.
