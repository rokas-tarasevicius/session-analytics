import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { TranscriptLifecycle } from "../src/metrics/transcript-lifecycle.ts";

test("native liveness treats offset-free timestamps as UTC across host timezones", () => {
  const script = `
    import { TranscriptLifecycle } from './src/metrics/transcript-lifecycle.ts';
    const now = Date.parse('2026-07-20T09:05:00Z');
    const times = ['2026-07-20T09:00:00', '2026-07-20 09:00:00', '2026-07-20T09:00:00Z', '2026-07-20T11:00:00+02:00'];
    console.log(JSON.stringify(['claude', 'codex'].flatMap(provider => times.map(timestamp => {
      const lifecycle = new TranscriptLifecycle();
      lifecycle.observe(provider, { type: provider === 'claude' ? 'user' : 'event_msg', timestamp, payload: { type: 'task_started' } });
      return lifecycle.liveness(now);
    }))));
  `;
  for (const zone of ["UTC", "Europe/London", "America/Los_Angeles"]) {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, TZ: zone } });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), Array(8).fill("active"), zone);
  }
});

test("native liveness rejects impossible dates and retains stale, future and settled semantics", () => {
  const now = Date.parse("2026-03-02T12:05:00Z");
  for (const provider of ["claude", "codex"] as const) {
    for (const timestamp of ["2026-02-30T12:00:00Z", "PRIVATE-LIFECYCLE-CONTENT-雪", "", null, 123, "2026-03-02T11:00:00Z", "2026-03-02T13:00:00Z"]) {
      const lifecycle = new TranscriptLifecycle();
      lifecycle.observe(provider, { type: provider === "claude" ? "user" : "event_msg", timestamp, payload: { type: "task_started" } });
      assert.equal(lifecycle.liveness(now), "unknown");
      lifecycle.observe(provider, provider === "claude" ? { type: "system", subtype: "turn_duration" } : { type: "event_msg", payload: { type: "task_complete" } });
      assert.equal(lifecycle.liveness(now), "inactive");
      assert.doesNotMatch(JSON.stringify(lifecycle.liveness(now)), /PRIVATE-LIFECYCLE-CONTENT/);
    }
  }
});
