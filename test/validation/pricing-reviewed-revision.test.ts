import assert from "node:assert/strict";
import test from "node:test";
import { catalogFromSnapshots, loadReviewed, resolveRate } from "../../src/pricing/catalog.ts";
import { sha256 } from "../../src/pricing/sources.ts";

test("same-date reviewed archive cannot restore a corrected legacy write surcharge", async () => {
  const current = await loadReviewed();
  const obsolete = structuredClone(current);
  obsolete.card.models["gpt-5.4"]!.cacheWriteMultiplier = 1.25;
  obsolete.payloadSha256 = sha256(JSON.stringify(obsolete.card));
  const catalog = catalogFromSnapshots(current, [obsolete], {}, new Date("2026-10-03T00:00:00Z"));
  for (const at of ["2026-07-01T00:00:00Z", "2026-10-02T00:00:00Z", "2026-10-03T00:00:00Z"]) {
    const actual = resolveRate(catalog, "gpt-5.4", at)!;
    assert.equal(actual.rate.cacheWriteMultiplier, 1);
    assert.equal(actual.provenance.payloadSha256, current.payloadSha256);
  }
  assert.equal(obsolete.card.models["gpt-5.4"]!.cacheWriteMultiplier, 1.25, "immutable source observation stays untouched");

  const historical = structuredClone(obsolete);
  historical.fetchedAt = "2026-09-01T00:00:00.000Z";
  historical.card.effectiveDate = "2026-09-01";
  historical.card.models["gpt-5.4"]!.inputPerMillion = 7;
  historical.payloadSha256 = sha256(JSON.stringify(historical.card));
  const dated = catalogFromSnapshots(current, [historical, obsolete], {}, new Date("2026-10-03T00:00:00Z"));
  assert.equal(resolveRate(dated, "gpt-5.4", "2026-09-02T00:00:00Z")!.rate.inputPerMillion, 7);
  assert.equal(resolveRate(dated, "gpt-5.4", "2026-10-03T00:00:00Z")!.rate.cacheWriteMultiplier, 1);

  const custom = catalogFromSnapshots(obsolete, [current], { rateCardPath: "synthetic-custom.json" });
  assert.equal(resolveRate(custom, "gpt-5.4", "2026-07-01T00:00:00Z")!.rate.cacheWriteMultiplier, 1.25);
});
