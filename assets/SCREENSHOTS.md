# Screenshot provenance

Dashboard screenshots contain synthetic fixtures only. They do not show developer session history.

All 26 captures were refreshed on 2026-10-20 from `node scripts/demo.ts --no-open --port 4175` with `node scripts/screenshots.ts --url http://127.0.0.1:4175`. The source baseline is `448efe3`, including the brand marks for every provider, the Top increases table and the dashboard fixes from the 2026-10-20 UI review.

The captured snapshot was generated at `2026-10-20T22:55:44.710Z`: 481 sessions across six fictional repositories and all seven providers, including 24 Antigravity sessions. Antigravity's token/tool fixtures contribute to provider charts, repository breakdowns, tool-call totals and coverage. These fixtures do not establish live Antigravity calibration or support for legacy `.pb` histories.

Desktop views use 1280 CSS pixels, comfortable density and the default 30-day window in both themes. Velocity opens with the default Model grouping. Summary includes the complete totals rail and provider breakdown. Subscription waits for its synthetic meters (two Claude profiles and one Codex account), then ends below the first row of account cards.

The mobile pair uses 375 × 812 CSS pixels, compact density and the same window. Chrome captures every image at 2× scale; `cwebp` converts the PNGs to lossless WebP without resizing. Detail captures are clipped to their panels with padding; longer views show their opening viewport. No real-history dashboard or proxy is used.

For scripted regeneration, start a synthetic demo and run:

```sh
node scripts/screenshots.ts --url http://127.0.0.1:4175
```

The script requires Chrome and either `cwebp` or ImageMagick (`magick`), produces 2× images, and accepts `--only mobile` for the phone pair. It prefers `cwebp` when available; both conversion paths are lossless. Never point it at a dashboard containing real session history before copying output into the repository.
