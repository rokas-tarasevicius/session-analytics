#!/usr/bin/env node
// Independent review of sanitized artifacts only. No provider files or src imports.
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const read = name => JSON.parse(readFileSync(`.lane/${name}.json`, 'utf8'));
const final = read('codex-reconciled');
const source = read('codex-source-control');
const receipts = read('codex-receipts-audit');
const initial = read('codex-comparison');
const raw = read('codex-observations');
const forks = read('codex-fork-replay-audit');
const sum = rows => rows.reduce((total, value) => total + value, 0);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, 'Independent dollar reconciliation failed');
const tokens = usage => usage[0] + usage[2];
const sourceVectors = new Set(source.requests.map(q => JSON.stringify(q.u)));
const receiptOverlap = receipts.missing.filter(q => sourceVectors.has(JSON.stringify(q.usage)));
assert.equal(receiptOverlap.length, 0, 'Receipt correction overlaps a legacy request vector');
assert.equal(new Set(receipts.missing.map(q => `${q.threadKey}:${q.responseKey}`)).size, receipts.missing.length, 'Receipt identity duplicated');
assert.equal(new Set(forks.rows.map(q => q.signature)).size, forks.rows.length, 'Fork correction signature duplicated');
assert.equal(receipts.missing.filter(q => q.compactionLinked).length, receipts.missing.length, 'Missing receipt lacks compaction provenance');

// Numeric equality is not response identity. Independently find counters backed
// by multiple distinct receipts with exact thread/turn/cumulative provenance.
const receiptStates = new Map();
for (const q of raw.observations.filter(q => q.kind === 'response' && !q.live)) {
  const state = JSON.stringify([q.thread, q.turn, q.u, q.threadTotal]);
  const list = receiptStates.get(state) || []; list.push(q); receiptStates.set(state, list);
}
const signatureReceipts = new Map();
for (const q of raw.observations.filter(q => q.kind === 'legacy' && !q.live)) {
  for (const receipt of receiptStates.get(JSON.stringify([q.key, q.turn, q.u, q.total])) || []) {
    const members = signatureReceipts.get(q.signature) || new Map();
    members.set(`${receipt.thread}:${receipt.response}`, receipt); signatureReceipts.set(q.signature, members);
  }
}
const collisions = [...signatureReceipts].filter(([, members]) => members.size > 1);
const collisionMissing = collisions.flatMap(([signature, members]) => {
  const claimed = new Set(source.requests.filter(q => q.signature === signature).map(q => q.key));
  return [...members.values()].filter(q => !claimed.has(q.thread));
});
const collisionCorrections = final.changes.filter(q => q.bug === 'CODEX-06');
assert.equal(collisionCorrections.length, collisionMissing.length, 'Distinct response collision remains uncorrected');
for (const change of collisionCorrections) {
  assert.ok(collisionMissing.some(q => q.thread === change.after.key && JSON.stringify(q.u) === JSON.stringify(change.after.u)), 'Collision correction lacks distinct receipt provenance');
}

const originals = new Map(raw.observations.filter(q => q.kind === 'legacy').map(q => [`${q.key}:${q.signature}:${q.at}`, q]));
const fallback = source.requests.filter(q => {
  const original = originals.get(`${q.key}:${q.signature}:${q.at}`);
  return original && tokens(original.u) === 0;
});
const fallbackMonths = new Set(fallback.map(q => q.month));
const receiptMonths = new Set(receipts.missing.map(q => q.at.slice(0, 7)));
assert.equal([...fallbackMonths].filter(month => receiptMonths.has(month)).length, 0, 'Cumulative fallback requires additional overlap inspection');
for (const change of final.changes.filter(q => q.bug === 'CODEX-02')) {
  assert.deepEqual(change.before.u, change.after.u, 'Ownership transfer changed physical tokens');
  near(change.before.usd, change.after.usd);
}
const expectedUsd = source.summary.deltaUsd + sum(Object.values(final.summary.perBug).map(q => q.deltaUsd));
near(expectedUsd, final.summary.deltaUsd);
const expectedTokens = source.summary.inputDelta + source.summary.outputDelta
  + sum(Object.values(final.summary.perBug).map(q => q.positiveTokens - q.negativeTokens));
assert.equal(expectedTokens, tokens(final.summary.delta), 'Independent physical-token reconciliation failed');
for (const rows of Object.values(final.comparison)) {
  near(sum(rows.map(q => q.deltaUsd)), final.summary.deltaUsd);
  near(sum(rows.map(q => q.oracle.usd)), final.summary.totals.usd);
  near(sum(rows.map(q => q.reference.usd)), final.summary.referenceTotals.usd);
}
const corrected = new Map(final.comparison.sessions.map(q => [q.key, q.oracle.u]));
const residuals = initial.matched.map(q => ({ sessionKey: q.sessionKey,
  delta: q.hybrid.map((value, i) => value - (corrected.get(q.sessionKey)?.[i] || 0)),
})).filter(q => q.delta.some(value => value !== 0));
if (typeof final.summary.remainingHeuristicDisagreements === 'number') {
  assert.equal(final.summary.remainingHeuristicDisagreements, residuals.length, 'Remaining heuristic disagreement count is incomplete');
}
const threadFiles = new Map();
for (const file of raw.sessions) {
  const list = threadFiles.get(file.key) || []; list.push(file); threadFiles.set(file.key, list);
}
const mixedLiveThreads = [...threadFiles.values()].filter(files => files.some(file => file.live) && files.some(file => !file.live)).length;
const report = {
  referenceGeneratedAt: final.summary.referenceGeneratedAt,
  independentChecksPassed: true,
  missingReceiptCount: receipts.missing.length,
  missingReceiptOverlapWithLegacyRequests: receiptOverlap.length,
  cumulativeFallbackRequests: fallback.length,
  cumulativeFallbackMonths: [...fallbackMonths].sort(),
  missingReceiptMonths: [...receiptMonths].sort(),
  distinctReceiptCollisionGroups: collisions.length,
  distinctReceiptCollisionMissingRequests: collisionMissing.length,
  distinctReceiptCollisionCorrectionUsd: final.summary.perBug['CODEX-06']?.deltaUsd,
  sourceControlResidualUsd: source.summary.deltaUsd,
  missingReceiptCorrectionUsd: final.summary.perBug['CODEX-01']?.deltaUsd,
  cumulativeReplayCorrectionUsd: final.summary.perBug['CODEX-05']?.deltaUsd,
  expectedNetUsd: expectedUsd,
  reportedNetUsd: final.summary.deltaUsd,
  expectedNetPhysicalTokens: expectedTokens,
  dimensionalCounts: Object.fromEntries(Object.entries(final.comparison).map(([area, rows]) => [area, rows.length])),
  mixedLiveThreads,
  remainingHeuristicDisagreements: residuals.length,
  remainingHeuristicDelta: residuals.reduce((total, row) => total.map((value, i) => value + row.delta[i]), [0,0,0,0,0]),
  qualification: 'Confirmed corrections reconcile on the source ownership heuristic; residual alternative-heuristic attribution is not independently proven ground truth.',
};
writeFileSync('.lane/codex-reconciliation-review.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
