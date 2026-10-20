import assert from "node:assert/strict";
import test from "node:test";
import { harness, sample } from "./validation/aggregation-ui-harness.ts";

// Regression: the two-minute passive limit request swallowed a manual forced refresh.
// Found by /qa on 2026-10-20; evidence: the red/green run of this file.
test("a manual limits refresh waits for an ongoing passive read and then requests fresh meters once", async () => {
  const { context, run } = await harness([sample()]);
  const urls: string[] = [];
  const responses: Array<(response: unknown) => void> = [];
  context["fetch"] = (url: string) => {
    urls.push(url);
    return new Promise((resolve) => responses.push(resolve));
  };
  const passive = run("loadLimits(false)");
  const manual = run("loadLimits(true)"), anotherManual = run("loadLimits(true)");
  let finished = false;
  manual.then(() => { finished = true; });
  assert.deepEqual(urls, ["/api/limits"], "no concurrent harvests");
  responses.shift()!({ ok: true, json: async () => ({ marker: "cached", machines: [] }) });
  await passive;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(urls, ["/api/limits", "/api/limits?refresh=1"]);
  assert.equal(finished, false, "manual completion includes the forced read");
  responses.shift()!({ ok: true, json: async () => ({ marker: "fresh", machines: [] }) });
  await Promise.all([manual, anotherManual]);
  assert.equal(run("limits.marker"), "fresh");
  assert.equal(urls.length, 2, "duplicate manual clicks share the queued refresh");
  const firstForced = run("loadLimits(true)"), followingPassive = run("loadLimits(false)");
  responses.shift()!({ ok: true, json: async () => ({ marker: "fresh-again", machines: [] }) });
  await Promise.all([firstForced, followingPassive]);
  assert.deepEqual(urls, ["/api/limits", "/api/limits?refresh=1", "/api/limits?refresh=1"]);
});

test("a polling scan stops on failure and preserves the previous exportable snapshot", async () => {
  const { context, document, run } = await harness([sample()]);
  const urls: string[] = [];
  context["fetch"] = async (url: string) => {
    urls.push(url);
    return urls.length < 3 ? { status: 202 } : { ok: false, status: 503, json: async () => ({ error: "Analysis failed." }) };
  };
  const snapshot = run("snapshot");
  await run("load(true)");
  assert.equal(run("snapshot"), snapshot);
  assert.equal(run("exportSelection().snapshot.sessions.length"), 1);
  assert.deepEqual(urls, ["/api/analytics?refresh=1&wait=10", "/api/analytics?wait=10", "/api/analytics?wait=10"]);
  assert.equal(document.querySelector("#refresh-button")!.disabled, false);
  assert.equal(document.querySelector("#generated-at")!.dataset["stale"], "true");
  assert.match(document.querySelector("#error-message")!.textContent, /HTTP 503/);
});
