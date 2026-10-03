import assert from "node:assert/strict";
import { ReliabilityCollector } from "../src/metrics/reliability.ts";

const c = new ReliabilityCollector({ contentRules: true, secret: Buffer.alloc(32, 27) });
const args = { changes: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`src/synthetic-${i}.ts`, { type: "update" }])) };
const start = performance.now();
global.gc?.();
const baseline = process.memoryUsage().heapUsed;
for (let i = 0; i < 2250; i++) {
  c.add({ id: `patch-${i}`, name: "apply_patch", args, cwd: "/synthetic", started: null });
  c.result(`patch-${i}`, { outcome: "success", error: null, durationMs: null });
  // Fail early on the original implementation, without deliberately exhausting its heap.
  if (i === 39) assert.equal(c.finish().coverage.truncated, true, "aggregate hashing safeguard must activate before retaining 40,000 references");
}
const projection = c.finish();
assert.equal(projection.flags, null);
assert.equal(projection.verification.share, null);
assert.equal(projection.verification.skip, null);
assert.equal(projection.tools[0]?.calls, 2250, "structured outcomes remain usable after hashing stops");
assert.ok(projection.coverage.fileCalls <= 17);
global.gc?.();
const usage = process.memoryUsage();
assert.ok(usage.heapUsed < 80 * 1024 * 1024, "leave most of the 256 MiB worker heap for the analyzer and serialization");
assert.ok(usage.heapUsed - baseline < 32 * 1024 * 1024);
console.log(JSON.stringify({ calls: 2250, truncated: projection.coverage.truncated, fileCalls: projection.coverage.fileCalls, heapBytes: usage.heapUsed, heapGrowthBytes: usage.heapUsed - baseline, rssBytes: usage.rss, milliseconds: Math.round(performance.now() - start) }));
