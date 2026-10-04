// Combine independently established corrections without exporting private snapshot fields.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
process.on('uncaughtException', () => { process.stderr.write('Time validation failed; local details suppressed.\n'); process.exit(1); });
const read = (p: string): any => JSON.parse(fs.readFileSync(p, 'utf8'));
const reference = read('../reference/snapshot-noindex-51ea561.json');
const claude = read('.lane/time-claude-oracle.json');
const claudeDiff = read('.lane/time-claude-diff.json');
const codex = read('.lane/codex-final-oracle.json');
const frozenLiveCodex = new Set<string>(read('.lane/codex-native-independent.json').liveSessionKeys);
const codexByKey = new Map<string, any>(codex.sessions.map((s: any) => [s.sessionKey, s]));
const claudeByKey = new Map<string, any>();
for (const s of claude.sessions) for (const key of [s.sessionKey, ...(s.alternateSessionKeys ?? [])]) claudeByKey.set(key, s);
const stableClaude = new Set(claudeDiff.matches.map((s: any) => s.sessionKey));
type Amount = { valueUsd: number; inputTokens: number; outputTokens: number };
const zero = (): Amount => ({ valueUsd: 0, inputTokens: 0, outputTokens: 0 });
const amount = (s: any): Amount => ({ valueUsd: s.valueUsd ?? s.totalUsd ?? 0, inputTokens: s.inputTokens ?? 0, outputTokens: s.outputTokens ?? 0 });
const plus = (a: Amount, b: Amount) => { for (const k of ['valueUsd', 'inputTokens', 'outputTokens'] as const) a[k] += b[k]; };
const groups: Record<string, Record<string, { reference: Amount; corrected: Amount; sessions: number }>> = { providers: {}, repositories: {}, models: {} };
const months: Record<string, { referenceUsd: number; correctedUsd: number; referenceLondonUsd: number; correctedLondonUsd: number }> = {};
const month = (day: string) => months[day.slice(0, 7)] ??= { referenceUsd: 0, correctedUsd: 0, referenceLondonUsd: 0, correctedLondonUsd: 0 };
const excluded: any[] = [], differences: any[] = [];
let stableSessions = 0;
for (const s of reference.sessions) {
  const c = codexByKey.get(s.sessionKey);
  const a = claudeByKey.get(s.sessionKey);
  const nativeClaude = s.provider === 'claude' && s.costBasis === 'api-list-price-equivalent';
  if (s.provider === 'codex' && !c && !frozenLiveCodex.has(s.sessionKey)) throw new Error('Unexplained missing stable Codex identity');
  if ((s.provider === 'codex' && frozenLiveCodex.has(s.sessionKey)) || (nativeClaude && !stableClaude.has(s.sessionKey))) {
    excluded.push({ sessionKey: s.sessionKey, provider: s.provider, referenceUsd: s.cost.totalUsd, inputTokens: s.tokens.inputTokens, outputTokens: s.tokens.outputTokens, referenceDays: s.spendByDay });
    continue;
  }
  stableSessions++;
  const ref = { valueUsd: s.cost.totalUsd, inputTokens: s.tokens.inputTokens, outputTokens: s.tokens.outputTokens };
  // Legacy aliases already reconciled independently; no content-based join here.
  const corrected = c ? amount(c.total) : a && nativeClaude ? amount(a.total) : nativeClaude ? { valueUsd: claudeDiff.matches.find((m: any) => m.sessionKey === s.sessionKey).oracle.cost, inputTokens: ref.inputTokens, outputTokens: ref.outputTokens } : ref;
  const sourceDays = c?.utc ?? (nativeClaude ? a?.byUtc : undefined);
  const days: Record<string, number> = sourceDays ? Object.fromEntries(Object.entries<any>(sourceDays).map(([d, v]) => [d, v.valueUsd ?? v.totalUsd])) : s.spendByDay;
  for (const d of new Set([...Object.keys(s.spendByDay), ...Object.keys(days)])) {
    const m = month(d);
    m.referenceUsd += s.spendByDay[d] ?? 0; m.correctedUsd += days[d] ?? 0;
  }
  const referenceLondon: Record<string, number> = {};
  for (const [day, , , values] of s.velocity?.buckets ?? []) referenceLondon[day] = (referenceLondon[day] ?? 0) + values[0];
  const localSource = c?.london ?? (nativeClaude ? a?.byLondon : undefined);
  const correctedLondon: Record<string, number> = localSource ? Object.fromEntries(Object.entries<any>(localSource).map(([d, v]) => [d, v.valueUsd ?? v.totalUsd])) : referenceLondon;
  for (const d of new Set([...Object.keys(referenceLondon), ...Object.keys(correctedLondon)])) {
    month(d).referenceLondonUsd += referenceLondon[d] ?? 0;
    month(d).correctedLondonUsd += correctedLondon[d] ?? 0;
  }
  const repo = createHash('sha256').update(`repository:${s.repositoryId}`).digest('hex').slice(0, 12);
  for (const [kind, key] of [['providers', s.provider], ['repositories', repo]]) {
    const g = groups[kind]![key] ??= { reference: zero(), corrected: zero(), sessions: 0 };
    plus(g.reference, ref); plus(g.corrected, corrected); g.sessions++;
  }
  const oracleModels = c?.models ?? (nativeClaude ? a?.byModel : undefined);
  const refModels = new Map<string, any>(s.models.map((m: any) => [m.model, m]));
  for (const model of new Set([...refModels.keys(), ...Object.keys(oracleModels ?? {})])) {
    const g = groups.models![model] ??= { reference: zero(), corrected: zero(), sessions: 0 };
    plus(g.reference, amount(refModels.get(model) ?? {}));
    plus(g.corrected, amount(oracleModels ? oracleModels[model] ?? {} : refModels.get(model) ?? {})); g.sessions++;
  }
  const delta = { valueUsd: corrected.valueUsd - ref.valueUsd, inputTokens: corrected.inputTokens - ref.inputTokens, outputTokens: corrected.outputTokens - ref.outputTokens };
  const dayDifferences = [...new Set([...Object.keys(s.spendByDay), ...Object.keys(days)])].map(day => ({ day, valueUsd: (days[day] ?? 0) - (s.spendByDay[day] ?? 0) })).filter(d => Math.abs(d.valueUsd) > 1e-6);
  if (Math.abs(delta.valueUsd) > 1e-6 || delta.inputTokens || delta.outputTokens || dayDifferences.length) differences.push({ sessionKey: s.sessionKey, provider: s.provider, repositoryKey: repo, ...delta, dayDifferences });
}
const totals = { reference: zero(), corrected: zero() };
for (const g of Object.values(groups.providers!)) { plus(totals.reference, g.reference); plus(totals.corrected, g.corrected); }
const result = { referenceTime: reference.generatedAt, stableSessions, excluded, totals, groups, months, differences };
fs.writeFileSync('.lane/time-final-report.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ stableSessions, excluded, totals, providers: groups.providers, months, differingSessions: differences.length }, null, 2));
