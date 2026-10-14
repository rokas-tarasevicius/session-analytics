# Screenshot provenance

Dashboard screenshots contain synthetic fixtures only. They do not show developer session history.

All captures were refreshed on 2026-10-13 from `node scripts/demo.ts --no-open --port 4193` through the T3 collaborative preview. Desktop views use 1280 CSS pixels and comfortable density, in light and dark themes. Velocity opens with the default Model grouping. Summary includes the complete totals rail and provider breakdown.

`screenshot-subscription.webp` and `screenshot-subscription-dark.webp` were captured on 2026-10-14 with `node scripts/screenshots.ts --only subscription` at 1280 CSS pixels, 2×, comfortable density, from the demo's synthetic limits (two Claude profiles and one Codex account). The capture waits for the meters, then ends below the first row of account cards.

`screenshot-mobile.webp` and `screenshot-mobile-dark.webp` use 375 × 812 CSS pixels, compact density and the default 30-day window. A temporary proxy exposed only the synthetic demo to the preview host. The preview's PNG output is 1× for desktop captures and 2× for mobile. ImageMagick converted it to lossless WebP without resizing; detail captures were cropped to their panels with padding. Longer views show their opening viewport.

For scripted regeneration, start a synthetic demo and run:

```sh
node scripts/screenshots.ts --url http://127.0.0.1:4193
```

The script requires Chrome and `cwebp`, produces 2× images, and accepts `--only mobile` for the phone pair. Never point it at a dashboard containing real session history before copying output into the repository.
