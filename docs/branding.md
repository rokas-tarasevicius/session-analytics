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

Palette, shared with the dashboard's light and dark themes ("Ink & Signal"; every token lives in `src/public/styles.css`):

| Role | Dark | Light (ink on warm paper) |
| --- | --- | --- |
| Page / panel / raised surface | `#121410` / `#181a16` (the tile) / `#1e211c` | `#ebe8df` / `#f4f2ec` / `#e9e6dd` |
| Text / secondary / muted | `#ecebe3` / `#b9bbb1` / `#8c8f86` | `#181a16` / `#43463f` / `#5f625a` |
| Coral — priced value, primary signal | `#d66b55` | mark `#c85b45`, text `#a94533` |
| Sage — cache, efficiency, success | `#7eb7a7` | mark `#3f8a77`, text `#2c6e5d` |
| Ochre — sub-agents, warnings | `#d4aa70` | mark `#a9792c`, text `#83601f` |
| Connector — rules, elbows, tree lines | `#62665c` | `#62665c` |
| Providers: Codex / Claude / Cursor | `#c6c5ba` / `#d66b55` / `#6796c7` | `#2a2c27` / `#c4553f` / `#32669a` |
| Repository series 1–6 | `#cc6859 #5488ca #879947 #ab6da6 #b7893b #3d9d80` | `#b54c3d #3164a3 #6a7b27 #8c5087 #a17003 #0c7b60` |
| Heatmap (sage ramp, 7 steps) | `#135742` to `#9bd6bf` | `#7db8a1` to `#004532` |

The series and heatmap steps were chosen with the `dataviz` palette validator (adjacent colour-vision ΔE ≥ 8.5, normal-vision ΔE ≥ 15, marks ≥ 3:1 on their surface); regenerate them the same way rather than by eye.

### Regenerating images

```bash
rsvg-convert -w 512 -h 512 assets/logo.svg -o assets/logo.png
rsvg-convert -w 1280 -h 640 assets/social-preview.svg -o assets/social-preview.png
```

Screenshots come from the demo dataset only. Start it with `npm run demo -- --no-open`, then capture `http://127.0.0.1:4175` at 1440 × 1100 in a headless browser. The dashboard reads `?view=<summary|distributions|activity|costs|models|tools|skills>&theme=<dark|light>&repository=<name>` once on load, so every view and theme can be captured without clicking. Never capture a dashboard that is reading real history.

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

Planned identifiers follow the same rule: MCP tool names will be generic (`budget_status`, `tool_reliability`), telemetry attributes will use the standard `gen_ai.*` namespace, and the JSON output will carry a `schemaVersion`. The data directory will be brand-derived, with a one-time migration when the brand changes.
