# Screenshot provenance

Dashboard screenshots contain synthetic fixtures only. They do not show developer session history.

All 26 captures were refreshed on 2026-10-23 from `SESSION_ANALYTICS_DEMO_NOW=2026-10-23T17:30:00Z node scripts/demo.ts --no-open --port 4175` with `node scripts/screenshots.ts --url http://127.0.0.1:4175`. The source baseline is `fc3a187` with the heavier demo workload, which puts the 30-day usage value near $14.6K: about $9.3K Claude, $4.8K Codex, and small Cursor, Gemini CLI, OpenCode and Antigravity shares.

The captured snapshot was generated at `2026-10-23T18:46:28.043Z`: 947 sessions across six fictional repositories and all seven providers, including 24 Antigravity sessions. Antigravity's token/tool fixtures contribute to provider charts, repository breakdowns, tool-call totals and coverage. These fixtures do not establish live Antigravity calibration or support for legacy `.pb` histories.

Desktop views use 1280 CSS pixels, comfortable density and the default 30-day window in both themes. Velocity opens with the default Model grouping. Summary includes the complete totals rail and provider breakdown. Subscription waits for its synthetic meters (two Claude profiles and one Codex account), then ends below the first row of account cards.

The mobile pair uses 375 × 812 CSS pixels, compact density and the same window. Chrome captures every image at 2× scale; `cwebp` converts the PNGs to lossless WebP without resizing. Detail captures are clipped to their panels with padding; longer views show their opening viewport. No real-history dashboard or proxy is used.

For scripted regeneration, start a synthetic demo and run:

```sh
node scripts/screenshots.ts --url http://127.0.0.1:4175
```

The script requires Chrome and either `cwebp` or ImageMagick (`magick`), produces 2× images, and accepts `--only mobile` for the phone pair. It prefers `cwebp` when available; both conversion paths are lossless. Never point it at a dashboard containing real session history before copying output into the repository.
