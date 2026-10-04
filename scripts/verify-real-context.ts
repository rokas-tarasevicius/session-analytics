/** Prove display-sampling changes from the fresh index's pre-budget public facts.
 * This never waives context counters or substitutes parser output for accounting
 * oracles. Source-unchanged sessions must reproduce both complete sampled curves.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
type Row = Record<string, any>;
export interface ContextInputs { capturedAt: string; source: string; rows: { sessionKey: string; context: Row }[] }
export async function captureContextInputs(directory: string, phase: string, dataDir: string): Promise<ContextInputs> {
  const database = new DatabaseSync(join(dataDir, 'index.sqlite'), { readOnly: true });
  try {
    const rows = [...database.prepare("SELECT json_extract(payload,'$.sessionKey') AS sessionKey, json_extract(payload,'$.limitsCache.context') AS context FROM sessions WHERE json_type(payload,'$.limitsCache.context')='object'").iterate()]
      .map(r => ({ sessionKey: String(r['sessionKey']), context: JSON.parse(String(r['context'])) as Row }));
    const evidence = { capturedAt: new Date().toISOString(), source: 'fresh-index-before-global-curve-budget', rows };
    await writeFile(join(directory, `context-inputs-${phase}.json`), JSON.stringify(evidence), { mode: 0o600 });
    return evidence;
  } finally { database.close(); }
}
export async function readContextInputs(directory: string, phase: string): Promise<ContextInputs | undefined> {
  try { return JSON.parse(await readFile(join(directory, `context-inputs-${phase}.json`), 'utf8')) as ContextInputs; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
function canonical(value: any): any {
  return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
}
const same = (a: any, b: any) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const counters = (context: Row) => { const { curve: _curve, curveSampled: _sampled, ...rest } = context; return rest; };
function sample(points: Row[], slots: number): Row[] {
  if (points.length <= slots) return points;
  if (!slots) return [];
  const peak = (values: Row[]) => values.reduce((a, b) => a.fill >= b.fill ? a : b);
  if (slots < 3) {
    const top = peak(points);
    return [...new Set(slots === 1 ? [top] : [points[0]!, top === points[0] ? points.at(-1)! : top])].sort((a, b) => a.request - b.request);
  }
  const selected = new Set([points[0]!, points.at(-1)!]);
  for (let i = 0; i < slots - 2; i++) selected.add(peak(points.slice(Math.floor(i * points.length / (slots - 2)), Math.floor((i + 1) * points.length / (slots - 2)))));
  return [...selected].sort((a, b) => a.request - b.request);
}
function allocate(lengths: Map<string, number>, maximum: number): Map<string, number> {
  const keys = [...lengths.keys()].sort(), budgets = new Map(keys.map(k => [k, 0]));
  for (let round = 1; maximum > 0; round++) {
    let used = 0;
    for (const key of keys) if (lengths.get(key)! >= round && maximum > 0) { budgets.set(key, round); maximum--; used++; }
    if (!used) break;
  }
  return budgets;
}
export function proveContextCurves(before: Row, after: Row, excluded: ReadonlySet<string>, evidence?: ContextInputs, maximum = 20_000) {
  const accepted: { sessionKey: string; beforeSlots: number; afterSlots: number; inputPoints: number }[] = [];
  if (!evidence || !excluded.size || evidence.source !== 'fresh-index-before-global-curve-budget' || !Number.isFinite(Date.parse(evidence.capturedAt))) return accepted;
  const inputs = new Map(evidence.rows.map(r => [r.sessionKey, r.context]));
  if (inputs.size !== evidence.rows.length) return accepted;
  const proofs: Map<string, number>[] = [];
  for (const snapshot of [before, after]) {
    const low = new Map<string, number>(), high = new Map<string, number>();
    for (const s of snapshot.sessions) {
      const context = s.limitsCache?.context; if (!context) continue;
      const eligible = context.eligibleRequests;
      if (!Number.isSafeInteger(eligible) || eligible < 0) return accepted;
      if (excluded.has(s.sessionKey)) {
        // Session sampling keeps one maximum per bin and may deduplicate its
        // two endpoints. All possible pre-budget lengths are bounded exactly.
        low.set(s.sessionKey, eligible > 240 ? 238 : eligible);
        high.set(s.sessionKey, Math.min(240, eligible));
      } else {
        const input = inputs.get(s.sessionKey);
        if (!input || !same(counters(context), counters(input)) || !Array.isArray(input.curve) || input.curve.length > Math.min(240, eligible)) return accepted;
        low.set(s.sessionKey, input.curve.length); high.set(s.sessionKey, input.curve.length);
      }
    }
    const minimum = allocate(low, maximum), maximums = allocate(high, maximum), proved = new Map<string, number>();
    for (const s of snapshot.sessions) {
      if (excluded.has(s.sessionKey) || !s.limitsCache?.context) continue;
      const slots = minimum.get(s.sessionKey)!;
      if (slots !== maximums.get(s.sessionKey)) continue;
      const input = inputs.get(s.sessionKey)!, actual = s.limitsCache.context;
      if (same(actual.curve, sample(input.curve, slots)) && actual.curveSampled === (input.curveSampled || input.curve.length > slots)) proved.set(s.sessionKey, slots);
    }
    proofs.push(proved);
  }
  const previous = new Map<string, Row>(before.sessions.map((s: Row) => [s.sessionKey, s]));
  for (const s of after.sessions) if (proofs[0]!.has(s.sessionKey) && proofs[1]!.has(s.sessionKey) && !same(previous.get(s.sessionKey)!.limitsCache.context, s.limitsCache.context)) {
    accepted.push({ sessionKey: s.sessionKey, beforeSlots: proofs[0]!.get(s.sessionKey)!, afterSlots: proofs[1]!.get(s.sessionKey)!, inputPoints: inputs.get(s.sessionKey)!.curve.length });
  }
  return accepted;
}
