/** Verify receipt/counter reconciliation against the sanitized raw projection and source control. */
import fs from 'node:fs';
import { priceUsage } from './pricing-oracle.mjs';

try {
  const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
  const raw = read('.lane/codex-observations.json');
  const control = read('.lane/codex-source-control.json');
  const live = new Set(raw.sessions.filter(s => s.live).map(s => s.key));
  const original = new Map(raw.observations.filter(o => o.kind === 'legacy').map(o => [`${o.key}:${o.signature}:${o.at}`, o]));
  const exact = new Map(), across = new Map();
  const vectorKey = (key, usage) => `${key}:${JSON.stringify(usage)}`;
  const exactKey = (key, turn, usage) => `${vectorKey(key, usage)}:${turn}`;
  for (const q of control.requests) {
    const event = original.get(`${q.key}:${q.signature}:${q.at}`);
    const a = vectorKey(q.key, q.u), e = exactKey(q.key, event?.turn ?? null, q.u);
    exact.set(e, (exact.get(e) ?? 0) + 1);
    across.set(a, (across.get(a) ?? 0) + 1);
  }
  const seen = new Set(), pending = [], unmatched = [], fallback = [];
  let exactMatches = 0;
  for (const event of raw.observations) {
    if (event.kind !== 'response' || live.has(event.key)) continue;
    const identity = `${event.thread}:${event.response}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const e = exactKey(event.key, event.turn, event.u), a = vectorKey(event.key, event.u), n = exact.get(e) ?? 0;
    if (n > 0) {
      exact.set(e, n - 1);
      across.set(a, (across.get(a) ?? 0) - 1);
      exactMatches++;
    } else pending.push(event);
  }
  for (const event of pending) {
    const a = vectorKey(event.key, event.u), n = across.get(a) ?? 0;
    if (n > 0) {
      across.set(a, n - 1);
      fallback.push({ threadKey: event.key, responseKey: event.response, usage: event.u });
    } else {
      const price = priceUsage(event.model, { input: event.u[0], cached: event.u[1], output: event.u[2], reasoning: event.u[3] }, { timestamp: event.at, requestInputTokens: event.u[0] });
      unmatched.push({ threadKey: event.key, responseKey: event.response, usage: event.u, usd: price.totalUsd });
    }
  }
  const result = { receipts: seen.size, exactMatches, unmatchedBeforeAcrossTurnFallback: pending.length, acrossTurnMatches: fallback.length, unmatchedAfterFallback: unmatched.length, additionalUsd: unmatched.reduce((n, row) => n + row.usd, 0), fallback, unmatched };
  fs.writeFileSync('.lane/codex-receipt-reconciliation-check.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ ...result, unmatched: undefined }, null, 2));
} catch {
  console.error('Receipt reconciliation check could not read or validate its inputs.');
  process.exitCode = 1;
}
