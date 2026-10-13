# Screenshot provenance

Dashboard screenshots contain synthetic fixtures only. They do not show developer session history.

The existing desktop WebP captures use the synthetic demo and `scripts/screenshots.ts`: 1280 CSS pixels wide, 2× scale, comfortable density, in light and dark themes. The 2026-10-13 release review preserved these files because the desktop layout did not change.

`screenshot-mobile.webp` and `screenshot-mobile-dark.webp` were captured on 2026-10-13 from `node scripts/demo.ts --no-open --port 4181` through the T3 collaborative preview, at 375 × 812 CSS pixels and 2× scale, with compact density and the default 30-day window. A temporary proxy exposed only that synthetic demo to the preview host. The PNG captures were converted to lossless WebP without resizing or content edits.

Regenerate the mobile pair from a running synthetic demo:

```sh
node scripts/screenshots.ts --url http://127.0.0.1:4181 --only mobile
```

The capture script requires Chrome and `cwebp`. Never point it at a dashboard containing real session history before copying output into the repository.
