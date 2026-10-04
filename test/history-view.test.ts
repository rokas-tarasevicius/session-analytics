import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { Element, documentFromHtml } from "./release-dom.ts";

test("history panel shows estimates, denominators, global scope and missing evidence without inserting HTML", async () => {
  const source = await readFile(new URL("../src/public/history-coverage.js", import.meta.url), "utf8");
  const document = documentFromHtml("<main></main>");
  const context = { document, Intl, renderHistoryCoverage: undefined as unknown as Function };
  runInNewContext(source.replaceAll("export ", "") + "\nthis.renderHistoryCoverage = renderHistoryCoverage;", context);
  const container = new Element();
  const history = { profiles: [{ ordinal: 1, status: "missing", firstTranscriptDay: "2026-08-25", firstStatisticsDay: null, months: [] }], undatedSessionValueUsd: 12,
    months: [{ month: "2026-07", statisticsCells: 1, sessionsWithDatedValue: 2, sessionEvidenceUsd: 20, unattributedEstimateUsd: 0, unattributedTokens: 2000, pricedUnattributedTokens: 0, possibleOverlapTokens: 100 }] };
  context.renderHistoryCoverage(container, history, []);
  assert.equal(container.hidden, false);
  for (const term of ["History coverage", "N/A", "0 / 2K", "independent of repository and date filters", "retention", "2026-08-25", "0/1 Claude profiles", "$12.00"]) assert.ok(container.textContent.includes(term), term);
  assert.equal(container.querySelectorAll("table").length, 1);
  assert.equal(container.querySelectorAll("details").length, 1);
  context.renderHistoryCoverage(container, { ...history, recoveryCalibration: { pairedSessions: 7, comparedSessions: 5, excludedSessions: 2,
    aggregateValueRatio: .9, nativeValueUsd: 10, recoveredValueUsd: 9, medianValueRatio: .95, p10ValueRatio: .7, p90ValueRatio: 1.01, receiptFloorSessions: 2, aboveNativeSessions: 1 } });
  for (const term of ["5 paired sessions", "90.0%", "$9.00 / $10.00", "p10–p90 70.0%–101.0%", "2/7 pairs", "provider-reported receipt floor", "no calibration multiplier"]) assert.ok(container.textContent.includes(term), term);
  context.renderHistoryCoverage(container, undefined);
  assert.equal(container.hidden, true); assert.equal(container.children.length, 0);
  assert.ok(!source.includes("innerHTML"));
});
