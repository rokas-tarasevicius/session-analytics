import assert from "node:assert/strict";
import test from "node:test";
import { harness, sample, withLedger } from "./validation/aggregation-ui-harness.ts";

// Regression: offset-free snapshot timestamps crashed Velocity's calendar indicators.
// Found by /qa on 2026-10-20; evidence: the red/green run of this file.
test("Velocity normalizes offset-free snapshot times before choosing calendar comparisons", async () => {
  const session = withLedger(sample(), [["synthetic", 3]]);
  const originalZone = process.env["TZ"];
  try {
    for (const zone of ["Pacific/Kiritimati", "America/Anchorage"]) {
      process.env["TZ"] = zone;
      const { context, document, run } = await harness([session], { timeZone: zone });
      context["velocityContextFixture"] = { start: "2026-09-01", end: "2026-10-03", generatedAt: "2026-10-03T12:00:00Z", timeZone: zone };
      run("renderVelocity(document.querySelector('#velocity-view'), fixture.sessions, velocityContextFixture)");
      const expected = document.querySelector("#velocity-view")!.textContent;
      for (const timestamp of ["2026-10-03T12:00:00", "2026-10-03 12:00:00"]) {
        context["velocityContextFixture"] = { ...context["velocityContextFixture"] as object, generatedAt: timestamp };
        assert.doesNotThrow(() => run("renderVelocity(document.querySelector('#velocity-view'), fixture.sessions, velocityContextFixture)"), `${zone}: ${timestamp}`);
        assert.equal(document.querySelector("#velocity-view")!.textContent, expected, `${zone}: ${timestamp}`);
      }
    }
  } finally {
    if (originalZone === undefined) delete process.env["TZ"]; else process.env["TZ"] = originalZone;
  }
});

test("window bounds use the normalized snapshot date, including empty history", async () => {
  const { run } = await harness([], { generatedAt: "2026-10-03T12:00:00", timeZone: "Pacific/Kiritimati" });
  assert.equal(run("observedRange().minimum"), "2026-10-04");
  assert.equal(run("observedRange().maximum"), "2026-10-04");
  run("fixture.sessions = [{ ...fixture.sessions[0], createdAt: '2026-10-02T12:00:00Z', spendByDay: { '2026-10-05': 1 } }]");
  assert.equal(run("observedRange().maximum"), "2026-10-04");
});
