/** Compare explicit response receipts with legacy counters without time-window guessing. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { priceUsage } from './pricing-oracle.mjs';

try {
const input = JSON.parse(fs.readFileSync('.lane/codex-observations.json', 'utf8'));
const files = new Map(input.sessions.map(s => [s.file, s]));
const observations = input.observations.map(o => ({ ...o, key: files.get(o.file)?.metas?.[0]?.id ?? o.key }));
const legacy = new Map();
for (const o of observations.filter(o => o.kind === 'legacy')) {
  const signature = JSON.stringify(o.u);
  if (!legacy.has(signature)) legacy.set(signature, []);
  legacy.get(signature).push(o);
}
const unique = new Map();
for (const o of observations.filter(o => o.kind === 'response' && !o.live)) {
  const key = `${o.thread}:${o.response}`;
  if (!unique.has(key)) unique.set(key, o);
}
const zero = () => ({ responses: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, usd: 0, upperUsd: 0 });
const add = (row, o, price) => {
  row.responses++;
  row.inputTokens += o.u[0]; row.cachedInputTokens += o.u[1]; row.outputTokens += o.u[2]; row.reasoningOutputTokens += o.u[3];
  row.totalTokens += o.u[0] + o.u[2]; row.usd += price.totalUsd; row.upperUsd += price.upperEstimateUsd;
};
const stats = { stableReceipts: unique.size, ownThread: 0, foreignThread: 0, sameThreadUsageMatches: 0, sameTurnUsageMatches: 0, otherThreadUsageOnly: 0, gapOver1Second: 0, gapOver10Seconds: 0, gapOver60Seconds: 0, missingUsage: 0 };
const missing = [], byMonth = {}, byModel = {}, bySession = {}, total = zero();
for (const o of unique.values()) {
  stats[o.thread === o.key ? 'ownThread' : 'foreignThread']++;
  const all = legacy.get(JSON.stringify(o.u)) ?? [];
  const local = all.filter(t => t.key === o.key);
  if (local.length) {
    stats.sameThreadUsageMatches++;
    if (local.some(t => t.turn === o.turn)) stats.sameTurnUsageMatches++;
    const gap = Math.min(...local.map(t => Math.abs(Date.parse(t.at) - Date.parse(o.at))));
    if (gap > 1000) stats.gapOver1Second++;
    if (gap > 10000) stats.gapOver10Seconds++;
    if (gap > 60000) stats.gapOver60Seconds++;
    continue;
  }
  if (all.length) { stats.otherThreadUsageOnly++; continue; }
  stats.missingUsage++;
  const price = priceUsage(o.model, { input: o.u[0], cached: o.u[1], output: o.u[2], reasoning: o.u[3] }, { timestamp: o.at, requestInputTokens: o.u[0] });
  const row = { sessionKey: o.key, responseKey: o.response, threadKey: o.thread, turnKey: o.turn, at: o.at, model: o.model, usage: o.u, usd: price.totalUsd, upperUsd: price.upperEstimateUsd, compactionLinked: false };
  missing.push(row);
  add(total, o, price);
  add(byMonth[o.at.slice(0, 7)] ??= zero(), o, price);
  add(byModel[o.model] ??= zero(), o, price);
  add(bySession[o.key] ??= zero(), o, price);
}

// Inspect ONLY missing-receipt files to prove their association with compaction.
// This pass retains no transcript content, paths, commands, or raw identities.
const hash = s => createHash('sha256').update(s).digest('hex').slice(0, 12);
const targets = new Set(missing.map(o => o.sessionKey));
const responseRows = new Map(missing.map(o => [o.responseKey, o]));
const homes = fs.readdirSync(os.homedir(), { withFileTypes: true }).filter(d => d.isDirectory() && (d.name === '.codex' || d.name.startsWith('.codex-'))).map(d => path.join(os.homedir(), d.name));
if (process.env.CODEX_HOME) homes.push(process.env.CODEX_HOME);
const scanned = new Set();
let linkedCompactions = 0;
for (const home of homes) for (const sub of ['sessions', 'archived_sessions']) {
  let root, entries;
  try { root = fs.realpathSync(path.join(home, sub)); entries = fs.readdirSync(root, { recursive: true, withFileTypes: true }); } catch { continue; }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ids = [...entry.name.matchAll(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g)].map(m => m[0]);
    if (!entry.name.endsWith('.jsonl') || !ids.some(id => targets.has(hash(`codex:${id}`)))) continue;
    const file = path.join(entry.parentPath, entry.name);
    if (scanned.has(file)) continue;
    scanned.add(file);
    let verifiedThread = false;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (!verifiedThread && r.type === 'session_meta') {
        if (typeof r.payload?.id !== 'string' || !targets.has(hash(`codex:${r.payload.id}`))) break;
        verifiedThread = true;
      }
      if (!verifiedThread) continue;
      if (r.type !== 'compacted') continue;
      const p = r.payload ?? {};
      for (const value of [p.compaction_response_id, p.latest_token_usage_record?.response_id]) {
        if (typeof value !== 'string') continue;
        const row = responseRows.get(hash(value));
        if (row && !row.compactionLinked) { row.compactionLinked = true; linkedCompactions++; }
      }
    }
  }
}
const result = { generatedAt: input.generatedAt, method: 'Unique thread_id+response_id; exact full usage vector match across all legacy events. No timestamp threshold. Missing means no equal legacy usage anywhere, a conservative lower bound.', stats, total, affectedSessions: Object.keys(bySession).length, linkedCompactions, byMonth, byModel, bySession, missing };
fs.writeFileSync('.lane/codex-receipts-audit.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ generatedAt: result.generatedAt, stats, total, affectedSessions: result.affectedSessions, linkedCompactions, byMonth, byModel }, null, 2));
} catch {
  console.error('Receipt audit could not read or validate its inputs.');
  process.exitCode = 1;
}
