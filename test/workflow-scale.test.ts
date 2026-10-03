import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { createWorkflowScope } from "../src/public/workflow-scope.js";
import type { WorkflowWorker } from "../src/public/workflow-scope.js";
import { summarizeWorkflow } from "../src/public/workflow-data.js";
import { workflowScaleFixture } from "./workflow-scale-fixture.ts";

test("review 6: 5,052-session scopes aggregate in a worker, yield during transfer and reuse bounded cached results", async (t) => {
  const { snapshot, inventory } = workflowScaleFixture();
  const repositories = snapshot.repositories.map((r) => r.repository.id);
  let workers = 0, calculations = 0, maxBatch = 0, maxCloneMs = 0, ticks = 0;
  const scope = createWorkflowScope({ cacheLimit: 2, workerFactory: () => {
    workers += 1;
    const worker = new Worker(new URL("./workflow-worker-harness.js", import.meta.url));
    const adapter: WorkflowWorker = {
      onmessage: null, onerror: null,
      postMessage(message) {
        const m = message as { type: string; sessions?: unknown[] };
        if (m.type === "select") calculations += 1;
        maxBatch = Math.max(maxBatch, m.sessions?.length ?? 0);
        const start = performance.now(); worker.postMessage(message); maxCloneMs = Math.max(maxCloneMs, performance.now() - start);
      },
      terminate() { void worker.terminate(); },
    };
    worker.on("message", (data) => adapter.onmessage?.({ data })); worker.on("error", () => adapter.onerror?.());
    return adapter;
  } });
  const timer = setInterval(() => { ticks += 1; }, 1);
  try {
    let start = performance.now();
    assert.strictEqual(scope.get(snapshot, snapshot.sessions.slice(), repositories), snapshot.workflow);
    const fullMs = performance.now() - start;
    assert.equal(workers, 0); assert.equal(calculations, 0);
    start = performance.now();
    const pending = scope.get(snapshot, snapshot.sessions, repositories, "codex");
    assert.ok(pending instanceof Promise);
    const requestMs = performance.now() - start, result = await pending, filteredMs = performance.now() - start;
    assert.ok(ticks > 10, "the main event loop must progress during transfer/calculation");
    assert.equal(maxBatch, 128); assert.equal(workers, 1); assert.equal(calculations, 1);
    assert.deepEqual(result, summarizeWorkflow(snapshot.sessions.filter((s) => s.provider === "codex"), { ...inventory, skills: inventory.skills.filter((s) => s.provider === "codex") }, snapshot.generatedAt, repositories));
    start = performance.now();
    assert.strictEqual(scope.get(snapshot, snapshot.sessions.slice().reverse(), repositories.slice().reverse(), "codex"), result);
    const revisitMs = performance.now() - start;
    assert.equal(calculations, 1);
    const empty = await scope.get(snapshot, [], ["repo-125"], "claude");
    assert.equal(empty.coverage.sessions, 0); assert.equal(empty.installedSkills.length, 2);
    assert.ok(empty.installedSkills.every((s) => s.observedInvocations === 0));
    const selected = snapshot.sessions.filter((s) => s.repositoryId === "repo-0");
    await scope.get(snapshot, selected, ["repo-0"]);
    assert.equal(calculations, 3);
    await scope.get(snapshot, snapshot.sessions, repositories, "codex");
    assert.equal(calculations, 4, "oldest of more than two filtered aggregates is evicted");
    const refreshed = { ...snapshot, generatedAt: "2026-08-02T00:00:00Z" };
    const fresh = await scope.get(refreshed, selected, ["repo-0"]);
    assert.equal(workers, 2); assert.equal(fresh.patterns.asOfDay, "2026-08-02");
    t.diagnostic(JSON.stringify({ sessions: snapshot.sessions.length, spans: snapshot.sessions.length * 2, fullMs, requestMs, filteredMs, revisitMs, maxCloneMs, maxBatch, eventLoopTicks: ticks }));
  } finally { clearInterval(timer); scope.dispose(); }
});

test("review 6: snapshot replacement cancels pending results and worker errors allow retry", async () => {
  const { snapshot } = workflowScaleFixture(10);
  let fail = true;
  const scope = createWorkflowScope({ workerFactory: () => {
    const worker: WorkflowWorker = { onmessage: null, onerror: null, terminate() {}, postMessage(message) {
      const data = message as { type: string; id: number };
      if (data.type !== "select") return;
      queueMicrotask(() => { if (fail) worker.onerror?.(); else worker.onmessage?.({ data: { id: data.id, result: summarizeWorkflow([]) } }); });
    } };
    return worker;
  } });
  try {
    const old = scope.get(snapshot, [], []);
    assert.strictEqual(scope.get({ ...snapshot }, snapshot.sessions, snapshot.repositories.map((r) => r.repository.id)), snapshot.workflow);
    assert.strictEqual(scope.get(snapshot, snapshot.sessions, snapshot.repositories.map((r) => r.repository.id)), snapshot.workflow);
    await assert.rejects(Promise.resolve(old), /unavailable/);
    await assert.rejects(Promise.resolve(scope.get(snapshot, [], [])), /unavailable/);
    fail = false;
    assert.equal((await scope.get(snapshot, [], [])).coverage.sessions, 0);
  } finally { scope.dispose(); }
});
