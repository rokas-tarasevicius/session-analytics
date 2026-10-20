import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./validation/aggregation-ui-harness.ts";

// Regression: freshness cards and Coverage links accepted executable/local URL schemes.
// Found by /qa on 2026-10-20; evidence: the red/green run of this file.
test("every Pricing and Coverage source link allows only HTTP(S)", async () => {
  const { context, document, run } = await harness([]);
  const urls = ["javascript:alert('synthetic')", "data:text/html,synthetic", "file:///synthetic-private-path", "https://example.com/rates", "HTTP://example.com/prices"];
  context["rateFixture"] = {
    effectiveDate: "2026-10-01", models: urls.map((source, index) => ({ model: `synthetic-${index}`, source })),
    pricing: { policy: "reviewed-first", offline: true, stale: false, warnings: [], refreshAfterDays: 7,
      sources: urls.map((url) => ({ source: "synthetic", ageDays: 1, models: 0, stale: false, url })) },
  };
  run("renderPricingPanel(document.querySelector('#pricing-panel'), rateFixture, [], { start: '2026-10-01', end: '2026-10-01' }); renderRateCards(rateFixture)");
  for (const selector of ["#pricing-panel", "#rate-card-links"]) {
    const links = document.querySelector(selector)!.querySelectorAll("a");
    assert.deepEqual(links.map((link) => (link as unknown as { href: string }).href).sort(), urls.slice(3).sort(), selector);
    assert.doesNotMatch(links.map((link) => (link as unknown as { href: string }).href).join(" "), /javascript:|data:|file:|synthetic-private-path/);
  }
});
