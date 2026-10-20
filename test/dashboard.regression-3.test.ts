import assert from "node:assert/strict";
import test from "node:test";
import { harness, sample, withLedger } from "./validation/aggregation-ui-harness.ts";

// Regression: a delayed machine poll could replace a completed refresh with its older snapshot.
// Found by /qa on 2026-10-20; evidence: the red/green run of this file.
test("a delayed quiet snapshot read cannot overwrite a newer manual refresh", async () => {
  for (const first of ["manual", "quiet"]) {
    const { context, document, run } = await harness([withLedger(sample(), [["synthetic", 1]])]);
    run("fixture.rateCard = { effectiveDate: '2026-10-01', models: [] }");
    const responses: Array<(response: unknown) => void> = [];
    context["fetch"] = () => new Promise((resolve) => responses.push(resolve));
    const oldSnapshot = run("fixture"), newSnapshot = { ...oldSnapshot, generatedAt: "2026-10-04T12:00:00Z" };
    const quiet = run("quietLoad()");
    const manual = run("load(true)");
    if (first === "quiet") { responses[0]!({ ok: true, json: async () => oldSnapshot }); await quiet; }
    responses[1]!({ ok: true, json: async () => newSnapshot });
    await manual;
    const generationLabel = document.querySelector("#generated-at")!.textContent;
    if (first === "manual") { responses[0]!({ ok: true, json: async () => oldSnapshot }); await quiet; }
    assert.equal(run("snapshot"), newSnapshot);
    assert.equal(document.querySelector("#generated-at")!.textContent, generationLabel);
    assert.equal(run("exportSelection().snapshot.generatedAt"), "2026-10-04T12:00:00Z");
  }
});
