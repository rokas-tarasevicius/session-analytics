import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { aggregateSessions } from "../../src/public/export-data.js";
import { conductorFallback } from "../../src/providers/conductor.ts";
import { calculateCost } from "../../src/analyzer.ts";
import { calibrateRecovery } from "../../src/metrics/recovery-calibration.ts";
import { validHistoryCoverage, validSessionHistory } from "../../src/metrics/history-validation.ts";
import { projectSession } from "../../src/store/projection.ts";
import { matchesSchema, snapshotSchema } from "../../src/interop/schema.ts";
import type { MachineAnalytics, RateCard, SessionAnalytics, SessionDatabaseRow } from "../../src/types.ts";

const secret = "/private/RECOVERY-SENTINEL token=never-export";
const model = "claude-sonnet-5", at = "2026-09-01T12:00:00.000Z";
const rates: RateCard = { currency: "USD", effectiveDate: "2026-01-01", models: { [model]: {
  provider: "claude", inputPerMillion: 2, outputPerMillion: 10, cacheReadPerMillion: .2,
  cacheWrite5mPerMillion: 2.5, cacheWrite1hPerMillion: 4, source: "https://example.com/rates",
} } };
const row: SessionDatabaseRow = { conductor_session_id: "private-registration", provider_session_id: "private-provider", agent_type: "claude", status: "completed", created_at: at, updated_at: at,
  repository_id: "discovered-00000000000000000000", repository_name: "Synthetic", repository_remote: secret, root_path: secret, default_branch: secret,
  workspace_path: secret, workspace_name: secret, title: secret, branch: secret, database_model: model, is_hidden: 0 };
const usage = (output: number, input = 100) => ({ input_tokens: input, cache_read_input_tokens: 200, cache_creation_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 30 }, output_tokens: output });
function fixture(run: (event: (data: Record<string, unknown>, time?: string) => void, recover: () => SessionAnalytics) => void) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE session_messages(id TEXT,session_id TEXT,content TEXT,full_message TEXT,created_at TEXT)");
  let sequence = 0;
  const event = (data: Record<string, unknown>, time = at) => {
    const v = { session_id: "private-provider", uuid: `private-event-${++sequence}`, ...data };
    db.prepare("INSERT INTO session_messages VALUES(?,?,?,?,?)").run(`row-${String(sequence).padStart(3, '0')}`, row.conductor_session_id, JSON.stringify(v), JSON.stringify(v), time);
  };
  const recover = () => conductorFallback(db, [row], new Set(), { rateCard: rates, price: calculateCost })[0]!;
  try { run(event, recover); } finally { db.close(); }
}
const assistant = (output: number, input = 100, extra: object = {}) => ({ type: "assistant", ...extra, message: { model, content: [{ type: "text", text: secret }], usage: usage(output, input) } });
const result = (output: number, input = 100, extra: object = {}) => ({ type: "result", usage: usage(output, input), total_cost_usd: 0, result: secret, subtype: "success", ...extra });

function verifyAccounting(session: SessionAnalytics) {
  const directory = mkdtempSync(join(tmpdir(), "recovery-accounting-"));
  try {
    const rollup = aggregateSessions([session]);
    const snapshot = { ...rollup, generatedAt: at, sessions: [session],
      summary: { ...rollup.summary, repositories: 1, repositoriesWithSessions: 1, workingSnapshots: 0 },
      repositories: [{ ...rollup, repository: { id: session.repositoryId, name: "Synthetic" } }] };
    const input = join(directory, "snapshot.json"), output = join(directory, "result.json");
    writeFileSync(input, JSON.stringify(snapshot));
    const child = spawnSync(process.execPath, [fileURLToPath(new URL("../../verify/aggregation/snapshot-oracle.mjs", import.meta.url)), input, output], { encoding: "utf8" });
    assert.equal(child.status, 0, "The synthetic accounting oracle must complete");
    return JSON.parse(readFileSync(output, "utf8")) as { mismatches: Array<{ field: string }> };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

for (const [label, first, second] of [
  ["one hour", "2026-09-01T12:01:00Z", "2026-09-01T12:59:00Z"],
  ["one UTC day across hours", "2026-09-01T12:00:00Z", "2026-09-01T13:00:00Z"],
  ["across midnight", "2026-09-01T23:59:00Z", "2026-09-02T00:01:00Z"],
] as const) test(`recovery accounting reconciles query output for ${label}`, () => fixture((event, recover) => {
  event(assistant(2), first); event(assistant(3, 101), second);
  event({ type: "result", total_cost_usd: 0, usage: { input_tokens: 201, cache_read_input_tokens: 400, cache_creation_input_tokens: 60, output_tokens: 1000 } }, second);
  const s = recover();
  assert.ok(validSessionHistory(s));
  assert.deepEqual(verifyAccounting(s).mismatches, []);
  const corrupt = structuredClone(s);
  corrupt.history!.undatedValueUsd += 1;
  assert.ok(verifyAccounting(corrupt).mismatches.some(m => m.field === "cost.datedAndUndatedUsd"), "An actual daily imbalance must still fail");
}));

test("recovery: exact query input proof adds final output once, without invented requests or reasoning", () => fixture((event, recover) => {
  event(assistant(2)); event(assistant(3)); event(result(1000));
  const s = recover();
  assert.equal(s.tokens.inputTokens, 330);
  assert.equal(s.tokens.outputTokens, 1000);
  assert.equal(s.tokens.nonReasoningOutputTokens, 0);
  assert.equal(s.metrics.modelCalls, 1);
  assert.equal(s.conductor?.reconciliation?.outputTokensRecovered, 997);
  assert.equal(s.history!.days[0]!.tokens, 1330);
  assert.equal(s.velocity!.buckets.reduce((n,b) => n + b[3][7], 0), 1);
  assert.ok(validSessionHistory(s));
  assert.equal(validSessionHistory({ ...s, conductor: { ...s.conductor!, reconciliation: { ...s.conductor!.reconciliation!, outputTokensRecovered: 1001 } } }), false);
  const saved = projectSession(s);
  assert.equal(saved.conductor?.reconciliation?.outputTokensRecovered, 997);
  for (const forbidden of [secret, "private-provider", "private-event", "private-registration"]) assert.ok(!JSON.stringify(saved).includes(forbidden));
}));

test("recovery: cumulative modelUsage and repeated init never become additive query output", () => fixture((event, recover) => {
  event(assistant(3)); event(result(100));
  event({ type: "system", subtype: "init", claude_code_version: "2.1.300" });
  event(assistant(4, 101));
  event(result(200, 201, { modelUsage: { [model]: { inputTokens: 201, outputTokens: 300, cacheReadInputTokens: 400, cacheCreationInputTokens: 60, costUSD: 0 } } }));
  const s = recover();
  assert.equal(s.tokens.outputTokens, 104, "cumulative-shaped usage fails query input agreement");
  assert.equal(s.tokens.inputTokens, 661);
  assert.equal(s.metrics.modelCalls, 2);
}));

test("recovery: model ambiguity, mismatched input and unfinished queries do not fabricate output", () => fixture((event, recover) => {
  event(assistant(2)); event(result(1000, 99));
  event(assistant(3, 101)); event({ ...assistant(4, 102), message: { model: "claude-opus-5", usage: usage(4,102) } });
  event({ type: "result", usage: { input_tokens: 203, cache_read_input_tokens: 400, cache_creation_input_tokens: 60, output_tokens: 5000 }, total_cost_usd: 0 });
  event(assistant(5, 103));
  const s = recover(); assert.equal(s.tokens.outputTokens, 14); assert.equal(s.conductor?.reconciliation?.outputTokensRecovered, undefined);
}));

test("recovery: a stripped copy with a retained response alias cannot prove a second identical request", () => fixture((event, recover) => {
  event({ ...assistant(3), uuid: "same-private-block" });
  event({ ...assistant(3), uuid: "same-private-block", message: { ...assistant(3).message, id: "private-response" } });
  event(assistant(2));
  event({ type: "result", total_cost_usd: 0, usage: { input_tokens: 200, cache_read_input_tokens: 400, cache_creation_input_tokens: 60, output_tokens: 1000 } });
  const s = recover(); assert.equal(s.tokens.outputTokens, 3); assert.equal(s.conductor?.reconciliation?.outputTokensRecovered, undefined);
}));

test("recovery: replayed records across distinct receipt UUIDs do not prove extra output", () => fixture((event, recover) => {
  event({ ...assistant(3), uuid: "replayed-private-block" }); event(result(1000));
  event({ ...assistant(3), uuid: "replayed-private-block" }); event(result(1000));
  const s = recover(); assert.equal(s.tokens.outputTokens, 3); assert.equal(s.conductor?.reconciliation?.outputTokensRecovered, undefined);
}));

test("recovery: a query spanning midnight retains supplemental output as undated", () => fixture((event, recover) => {
  event(assistant(2), "2026-09-01T23:59:00.000Z");
  event(assistant(3, 101), "2026-09-02T00:01:00.000Z");
  event({ type: "result", total_cost_usd: 0, usage: { input_tokens: 201, cache_read_input_tokens: 400, cache_creation_input_tokens: 60, output_tokens: 1000 } }, "2026-09-02T00:02:00.000Z");
  const s = recover(); assert.equal(s.tokens.outputTokens, 1000); assert.equal(s.history!.undatedTokens, 995);
  assert.equal(s.velocity!.undated.reduce((n,b) => n + b[1][5], 0), 995);
  assert.ok(validSessionHistory(s));
}));

test("recovery: higher receipt floor keeps provider accounting separate and preserves SDK overlap evidence", () => fixture((event, recover) => {
  event(assistant(3)); event(result(1000, 100, { total_cost_usd: 2 }));
  const s = recover();
  assert.equal(s.cost.totalUsd, 2); assert.equal(s.costBasis, "provider-reported");
  assert.equal(s.evidence!.source, "conductor-result"); assert.equal(s.costComplete, false);
  assert.equal(s.conductor!.reconciliation!.receiptFloorApplied, true);
  assert.equal(s.conductor!.reconciliation!.status, "partial");
  assert.ok(s.conductor!.reconciliation!.messageValueUsd < 2);
  assert.deepEqual(s.spendByDay, {}); assert.equal(s.history, undefined);
  assert.deepEqual(verifyAccounting(s).mismatches, [], "The receipt floor must never be added to API value or assigned message dates");
  assert.equal(s.historyStatistics!.days[0]!.tokens, 333);
  assert.ok(validSessionHistory(projectSession(s)));
}));

test("recovery: callback calibrates canonical pairs without adding their usage to history", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE session_messages(id TEXT,session_id TEXT,content TEXT,created_at TEXT)");
  db.prepare("INSERT INTO session_messages VALUES(?,?,?,?)").run("record", row.conductor_session_id, JSON.stringify({ ...assistant(3), session_id: "private-provider" }), at);
  try {
    const paired: SessionAnalytics[] = [];
    assert.deepEqual(conductorFallback(db,[row],new Set(["claude:private-provider"]),{rateCard:rates,price:calculateCost},s=>paired.push(s)),[]);
    assert.equal(paired.length,1);
  } finally { db.close(); }
});

test("recovery calibration: pooled value, interpolated quantiles, minimum cohort and honest exclusions", () => {
  const native = Array.from({length:8},(_,i) => ({ sessionKey:String(i),provider:"claude",cost:{totalUsd:10},costBasis:"api-list-price-equivalent",pricedTokenCoverage:1,
    transcript:{files:1,completeness:"complete",liveness:"inactive",snapshotWhileWorking:false} } as SessionAnalytics));
  native[5]!.transcript.completeness = "partial"; native[6]!.transcript.liveness = "active"; native[7]!.cost.totalUsd = .5;
  native[0]!.repositoryName = secret;
  const recovered = native.map((s,i)=>({sessionKey:s.sessionKey,cost:{totalUsd:6+i}} as SessionAnalytics));
  const result = calibrateRecovery(native,recovered);
  assert.equal(result.pairedSessions,8); assert.equal(result.comparedSessions,5); assert.equal(result.excludedSessions,3);
  assert.equal(result.aggregateValueRatio,.8); assert.equal(result.medianValueRatio,.8);
  assert.equal(result.p10ValueRatio,.64); assert.ok(Math.abs(result.p90ValueRatio!-.96)<1e-12);
  assert.equal(calibrateRecovery(native.slice(0,4),recovered).aggregateValueRatio,null);
  assert.ok(!JSON.stringify(result).includes(secret));
  const schema = { ...snapshotSchema.$defs!["RecoveryCalibration"]!, $defs: snapshotSchema.$defs };
  assert.ok(matchesSchema(result, schema));
  assert.equal(matchesSchema({ ...result, content: secret }, schema), false);
  const empty = calibrateRecovery([], []);
  const snapshot = { sessions: [], historyCoverage: { version: 1, scope: "machine", profiles: [], months: [], undatedSessionValueUsd: 0, unassignedProfileTokens: 0,
    recoveryCalibration: { ...empty, nativeValueUsd: 1 } } } as unknown as MachineAnalytics;
  assert.equal(validHistoryCoverage(snapshot), false, "zero compared pairs cannot carry a monetary operand");
});
