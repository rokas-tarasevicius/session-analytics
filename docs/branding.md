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

Palette, shared with the dashboard's light and dark themes. The exact logo hexes are used for UI accents (active states, focus rings, status dots); provider charts use the brand palette below; other categorical charts retain the product hues. Dashboard type is Geist (text) and Geist Mono (figures), both bundled under the OFL:

| Role | Color |
| --- | --- |
| Ink (tile, light-theme text) | `#181a16` |
| Paper (light background) | `#efeee7` |
| Coral (top-level span, accent) | `#d66b55`, text accent `#c85b45` |
| Sage (sub-agent span) | `#7eb7a7` |
| Ochre (sub-agent span) | `#d4aa70` |
| Connector | `#62665c` |
| Heatmap ramp (light) | `#eef2ef` to `#005742` (sage, light to dark) |
| Heatmap ramp (dark) | `#1a1c18` to `#7eddc0` (sage, dark to light) |
| Dark surfaces | page `#0e0f0d`, card `#151613`, raised `#1b1d19` / `#22241f`, border `#262823` |
| Light surfaces | page `#f4f4f1`, card `#ffffff`, raised `#f6f6f3` / `#ecece8`, border `#e4e4df` |

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
| Unknown / unsupported | `#c4c4bd` | `#4a4c46` |
| Neutral single series (repositories, tools, delegation) | `#006855` | `#68bea8` |

OpenAI greys deliberately depart from the chroma floor to preserve brand identity; series are always labelled. Cursor's monochrome mark uses cyan-teal in charts to distinguish it from OpenAI.

Model shades belong to the family, never its rank or value: flagship tier 0, standard tier 1, named/Codex variants tier 2 (unknown named families use a stable tier 1/2 hash), light tier 3. Opus, Sonnet and Haiku always use tiers 0, 1 and 3. Light tiers use Oklab mixes of base 72% + black, base, base 72% + white, base 50% + white. Dark tiers use base 70% + white, base, base 72% + black, base 52% + black. Claude and GPT have explicit shades:

| Family | Theme | Tier 0 | Tier 1 | Tier 2 | Tier 3 |
| --- | --- | --- | --- | --- | --- |
| Claude | Light | `#9a4127` | `#c96442` | `#df8a66` | `#ecb49a` |
| Claude | Dark | `#f2a887` | `#d8683f` | `#ae4f2f` | `#87402a` |
| GPT / Codex | Light | `#262624` | `#5c5c59` | `#8a8a86` | `#b5b5b0` |
| GPT / Codex | Dark | `#e6e6e1` | `#9a9a96` | `#73736f` | `#555551` |

The `--series-1..6` categorical slots (coral `#c15f4b`, sage `#006855`, ochre `#daa75d`, deep coral `#7b2717`, connector `#62665c`, pale sage `#65af9c` in light; `#cf6b57`, `#68bea8`, `#e1ad63`, `#2c7866`, `#edab9d`, `#62665c` in dark) remain only for Velocity's non-provider groups (repository, execution kind, effort), and `--heat-*` remains the sage ramp for the activity heatmap. The provider hues pass the data-viz validator's adjacent-pair checks in provider order (worst adjacent CVD ΔE 10.7 light, 9.9 dark); with all six on screen at once, Gemini blue and Copilot purple are close under deuteranopia, so provider charts always carry a labelled legend. Cost components use shades of the provider hue (or neutral sage for repositories), with stripes for provider-reported value. Legends use readable neutral text and support pointer and keyboard highlighting. Cost, model and tool bars share the maximum across their panel, with no minimum fill width.

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
