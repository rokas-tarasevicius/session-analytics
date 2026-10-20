import assert from "node:assert/strict";
import test from "node:test";
import { harness, sample, withLedger } from "./validation/aggregation-ui-harness.ts";

// Regression: observed zero baselines were labelled as small baselines rather than new activity.
// Found by /qa on 2026-10-20; evidence: the red/green run of this file.

test("Velocity calls an increase from an observed zero baseline new", async () => {
  const before = withLedger(sample(), [["old-synthetic", 0]], { day: "2026-09-01" });
  const current = withLedger(sample(), [["new-synthetic", 10]], { day: "2026-09-30", calls: 4 });
  const { document, run } = await harness([before, current]);
  run("renderVelocity(document.querySelector('#velocity-view'), fixture.sessions, { start: '2026-09-01', end: '2026-09-30', generatedAt: '2026-10-01T12:00:00Z', timeZone: 'UTC' })");
  const table = document.querySelector(".velocity-movers")!;
  assert.ok(table);
  for (const row of table.querySelector("tbody")!.children) assert.equal(row.children[5]!.textContent, "New");
  assert.doesNotMatch(table.textContent, /small baseline|Infinity|NaN/);
});
