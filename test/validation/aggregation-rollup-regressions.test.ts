import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeMachineSessions } from "../../src/analyzer.ts";
import { aggregateSessions, filterSnapshot } from "../../src/public/export-data.js";
import { coverageWarnings } from "../../src/public/evidence.js";
import { emptySession } from "../../src/providers/common.ts";
import type { MachineAnalytics, SessionAnalytics } from "../../src/types.ts";
import { createSessionAnalyticsFixture } from "../fixtures.ts";
import { validateSnapshot } from "../../src/interop/snapshot.ts";

function empty(): SessionAnalytics {
  return emptySession({ id: "synthetic", path: "", cwd: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }, "claude", {
    repository: { id: "discovered-aaaaaaaaaaaaaaaaaaaa", name: "Synthetic" },
    rateCard: { currency: "USD", effectiveDate: "2026-01-01", models: {} },
    price: () => ({ inputUsd: 0, outputUsd: 0, cachedInputUsd: 0, cacheWriteUsd: 0, totalUsd: 0, upperEstimateUsd: 0 }),
  }, { source: "conductor-result", fidelity: "summary", tokens: "unavailable", tools: "unavailable", turns: "unavailable", timing: "provider", usageUnit: "session", accounting: "partial" });
}

test("AGG-001: partially priced requests retain explicitly priced token classes in velocity", async () => {
  const root = await mkdtemp(join(tmpdir(), "aggregation-partial-price-"));
  try {
    const fixture = await createSessionAnalyticsFixture(root, "claude-partial-fixture");
    const rateCardPath = join(root, "rates.json");
    await writeFile(rateCardPath, JSON.stringify({ currency: "USD", effectiveDate: "2026-01-01", models: {
      "claude-partial-fixture": { provider: "claude", inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3, cacheWrite5mPerMillion: 3.75, cacheWrite1hPerMillion: 6, assumptions: ["anthropic-cache-1h-2x"], source: "https://example.com/rates" },
    } }));
    const snapshot = await analyzeMachineSessions({ ...fixture, offline: true, rateCardPath });
    const sessions = snapshot.sessions.filter(s => s.provider === "claude" && s.models.some(m => m.model === "claude-partial-fixture"));
    assert.ok(sessions.length > 0);
    let eligible = 0, priced = 0, velocityPriced = 0;
    for (const session of sessions) {
      eligible += session.models.reduce((n, m) => n + (m.pricingCoverage?.eligibleTokens || 0), 0);
      priced += session.models.reduce((n, m) => n + (m.pricingCoverage?.pricedTokens || 0), 0);
      velocityPriced += [...session.velocity!.buckets.map(c => c[3]), ...session.velocity!.undated.map(c => c[1])].reduce((n, values) => n + values[10], 0);
    }
    assert.ok(priced > 0 && priced < eligible, "synthetic usage has explicit input/read/5m/output rates and an estimated one-hour multiplier");
    assert.equal(velocityPriced, priced, "rate assumptions must exclude only estimated classes from velocity coverage");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("AGG-002: partial reported accounting and zero-token activity are not unpriced models", () => {
  const reported = empty(); reported.costBasis = "provider-reported";
  reported.cost.totalUsd = 10; reported.cost.upperEstimateUsd = 10;
  const activity = empty(); activity.evidence!.source = "cursor-transcript";
  activity.evidence!.fidelity = "activity-only";
  const unpriced = empty(); unpriced.pricedTokenCoverage = 0;
  unpriced.tokens.inputTokens = 100; unpriced.tokens.uncachedInputTokens = 100;
  assert.equal(aggregateSessions([reported, activity, unpriced]).summary.unpricedSessions, 1);
});

test("AGG-002: exported coverage warnings do not call reported accounting failures missing rate cards", () => {
  const reported = empty(); reported.costBasis = "provider-reported";
  assert.deepEqual(coverageWarnings([reported]), []);
});

test("AGG-007: filtering retains the exclusion of historical working snapshots", () => {
  const retained = empty(); retained.transcript.snapshotWhileWorking = true;
  retained.transcript.sourceDeleted = true;
  const unavailable = empty(); unavailable.sessionKey = "bbbbbbbbbbbb"; unavailable.transcript.snapshotWhileWorking = true;
  unavailable.transcript.warnings = ["Source availability could not be checked; showing the last indexed facts."];
  const sessions = [retained, unavailable], aggregated = aggregateSessions(sessions);
  const snapshot: MachineAnalytics = { schemaVersion: 1, generatedAt: "2026-01-02T00:00:00Z", rateCard: { currency: "USD", effectiveDate: "2026-01-01", models: [] },
    sessions, repositories: [{ repository: { id: retained.repositoryId, name: "Synthetic" }, ...aggregated }],
    ...aggregated, summary: { ...aggregated.summary, repositories: 1, repositoriesWithSessions: 1, workingSnapshots: 0 },
  };
  assert.equal(filterSnapshot(snapshot, {}).summary.workingSnapshots, 0);
});

test("AGG-008: an empty input denominator has no cache-read percentage", () => {
  assert.equal(aggregateSessions([]).summary.cacheReadRatio, null);
  assert.equal(aggregateSessions([empty()]).summary.cacheReadRatio, null);
});

test("AGG-002/008: legacy derived coverage is normalized without accepting unrelated arithmetic drift", () => {
  const session = empty(), aggregated = aggregateSessions([session]);
  const current: MachineAnalytics = { schemaVersion: 1, generatedAt: "2026-01-02T00:00:00Z",
    rateCard: { currency: "USD", effectiveDate: "2026-01-01", models: [] }, sessions: [session],
    repositories: [{ repository: { id: session.repositoryId, name: session.repositoryName }, ...aggregated }],
    ...aggregated, summary: { ...aggregated.summary, repositories: 1, repositoriesWithSessions: 1, workingSnapshots: 0 },
  };
  assert.deepEqual(validateSnapshot(current), current);
  const legacy = structuredClone(current);
  for (const rollup of [legacy, ...legacy.repositories]) {
    rollup.summary.unpricedSessions = 1;
    rollup.summary.cacheReadRatio = 0;
    rollup.warnings.push("1 sessions include models without a rate card.");
  }
  const normalized = validateSnapshot(legacy);
  assert.equal(normalized.summary.cacheReadRatio, null);
  assert.equal(normalized.summary.unpricedSessions, 0);
  assert.equal(normalized.repositories[0]!.summary.unpricedSessions, 0);
  assert.deepEqual(normalized.warnings, current.warnings);
  assert.equal(legacy.summary.cacheReadRatio, 0, "normalization does not mutate the supplied snapshot");
  legacy.summary.estimatedSpendUsd = 1;
  assert.throws(() => validateSnapshot(legacy));
});
