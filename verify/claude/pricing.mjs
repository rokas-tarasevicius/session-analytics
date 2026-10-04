/** Independent Claude pricing oracle. Built from docs/pricing.md and cached rate data;
 * deliberately imports no implementation under src/. Reads only reference pricing metadata. */
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const canonical = id => id.replace(/^(?:anthropic|openai)\//, '').replace(/(\d)\.(?=\d)/g, '$1-');
const undated = id => canonical(id).replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, '');

export function matchRate(model, models) {
  if (Object.hasOwn(models, model)) return { model, rate: models[model], match: 'exact' };
  const entries = Object.entries(models);
  const normalized = entries.filter(([id]) => canonical(id) === canonical(model));
  if (normalized.length === 1) return { model: normalized[0][0], rate: normalized[0][1], match: 'alias' };
  if (normalized.length > 1) return null;
  const dated = entries.filter(([id]) => undated(id) === undated(model));
  const plain = dated.filter(([id]) => canonical(id) === undated(id));
  const candidates = plain.length ? plain : dated;
  return candidates.length === 1 ? { model: candidates[0][0], rate: candidates[0][1], match: 'alias' } : null;
}

export function loadReferencePricing({
  referencePath = resolve(project, '../reference/snapshot-noindex-51ea561.json'),
  cacheDirectory = process.env.CLAUDE_ORACLE_PRICING_DIR || join(homedir(), 'Library/Application Support/session-analytics/pricing'),
  cardPath = resolve(project, 'data/rate-cards.json'),
} = {}) {
  const metadata = JSON.parse(readFileSync(referencePath, 'utf8')).rateCard;
  const snapshots = [];
  const reviewed = [];
  for (const file of readdirSync(cacheDirectory)) {
    if (!file.endsWith('.json') || file.startsWith('rates-')) continue;
    const envelope = JSON.parse(readFileSync(join(cacheDirectory, file), 'utf8'));
    const snapshot = envelope.snapshot;
    if (!snapshot) continue;
    if (snapshot.source === 'reviewed') { reviewed.push(snapshot); continue; }
    const wanted = metadata.pricing.sources.find(source => source.source === snapshot.source && source.payloadSha256 === snapshot.payloadSha256 && source.fetchedAt === snapshot.fetchedAt);
    if (!wanted) continue;
    const models = snapshot.models ?? JSON.parse(readFileSync(join(cacheDirectory, `rates-${snapshot.modelsSha256}.json`), 'utf8'));
    snapshots.push({ ...snapshot, models });
  }
  if (snapshots.length !== metadata.pricing.sources.length) throw new Error('Reference pricing evidence is incomplete');
  const bundled = JSON.parse(readFileSync(cardPath, 'utf8'));
  return { sources: metadata.pricing.sources.map(source => source.source), snapshots, reviewed, bundled, policy: metadata.pricing.policy };
}

export function createPricer(evidence) {
  const sourceOrder = evidence.sources ?? ['models.dev', 'litellm'];
  const observations = sourceOrder.map(source => evidence.snapshots.filter(snapshot => snapshot.source === source).sort((a, b) => Date.parse(a.fetchedAt) - Date.parse(b.fetchedAt)));
  const bundledAt = `${evidence.bundled.effectiveDate}T00:00:00.000Z`;
  const cards = [...(evidence.reviewed ?? [])].filter(card => card.fetchedAt !== bundledAt);
  cards.push({ source: 'reviewed', fetchedAt: bundledAt, card: evidence.bundled, reviewedOverrides: evidence.bundled.reviewedOverrides });
  cards.sort((a, b) => Date.parse(a.fetchedAt) - Date.parse(b.fetchedAt));
  function select(model, timestamp) {
    const at = Date.parse(timestamp);
    const validTime = Number.isFinite(at);
    const earlyCards = validTime ? cards.filter(card => Date.parse(card.fetchedAt) <= at) : cards;
    const card = earlyCards.at(-1) ?? cards[0];
    const reviewedMatch = matchRate(model, card.card.models);
    const overrides = card.reviewedOverrides ?? card.card.reviewedOverrides;
    const isOverride = reviewedMatch && (!overrides || overrides.includes(reviewedMatch.model));
    const reviewedResult = kind => reviewedMatch && ({ ...reviewedMatch, source: 'reviewed', kind, snapshotDate: card.fetchedAt, temporal: !validTime ? 'undated' : Date.parse(card.fetchedAt) <= at ? 'historical' : 'oldest' });
    if (evidence.policy === 'reviewed-only') return reviewedResult('reviewed');
    if (evidence.policy !== 'api-first' && isOverride) return reviewedResult('reviewed');
    // Timely evidence from any source wins over future first observations.
    const choices = observations.map(list => {
      if (!list.length) return null;
      const early = validTime ? list.filter(snapshot => Date.parse(snapshot.fetchedAt) <= at) : list;
      return { snapshot: early.at(-1) ?? list[0], timely: early.length > 0 };
    });
    for (const timely of [true, false]) for (const choice of choices) {
      if (!choice || choice.timely !== timely) continue;
      const found = matchRate(model, choice.snapshot.models);
      if (found) return { ...found, source: choice.snapshot.source, kind: 'api', snapshotDate: choice.snapshot.fetchedAt, temporal: !validTime ? 'undated' : timely ? 'historical' : 'oldest' };
    }
    return reviewedResult(isOverride ? 'reviewed' : 'fallback');
  }
  return function price(model, usage, timestamp) {
    const selected = select(model, timestamp);
    const zero = { costUSD: 0, inputUSD: 0, cacheReadUSD: 0, cacheWriteUSD: 0, outputUSD: 0, priced: false, pricedTokens: 0, provenance: null };
    if (!selected) return zero;
    const base = selected.rate;
    const count = key => Number.isFinite(usage[key]) && usage[key] >= 0 ? usage[key] : 0;
    const input = count('input'), read = count('cacheRead'), write5 = count('cacheWrite5m'), write1 = count('cacheWrite1h'), unsplit = count('cacheWriteUnknown'), output = count('output');
    // Reasoning is a subset of output, never another charged class.
    const context = typeof usage.contextInput === 'number' && Number.isFinite(usage.contextInput) && usage.contextInput >= 0 ? usage.contextInput : input + read + write5 + write1 + unsplit;
    const tier = [...(base.contextTiers ?? [])].filter(tier => context > tier.aboveInputTokens).sort((a,b) => b.aboveInputTokens - a.aboveInputTokens)[0];
    const inputMultiplier = !tier && base.longContext && context > base.longContext.thresholdInputTokens ? base.longContext.inputMultiplier : 1;
    const outputMultiplier = !tier && base.longContext && context > base.longContext.thresholdInputTokens ? base.longContext.outputMultiplier : 1;
    const inRate = tier?.inputPerMillion ?? base.inputPerMillion * inputMultiplier;
    const outRate = tier?.outputPerMillion ?? base.outputPerMillion * outputMultiplier;
    const readRate = tier?.cacheReadPerMillion ?? tier?.cachedInputPerMillion ?? ((base.cacheReadPerMillion ?? base.cachedInputPerMillion ?? base.inputPerMillion) * inputMultiplier);
    const write5Rate = tier?.cacheWrite5mPerMillion ?? ((base.cacheWrite5mPerMillion ?? base.inputPerMillion * (base.cacheWriteMultiplier ?? 1)) * inputMultiplier);
    const write1Rate = tier?.cacheWrite1hPerMillion ?? (base.cacheWrite1hPerMillion != null ? base.cacheWrite1hPerMillion * inputMultiplier : write5Rate);
    const inputUSD = input * inRate / 1e6;
    const cacheReadUSD = read * readRate / 1e6;
    const cacheWriteUSD = (write5 * write5Rate + write1 * write1Rate + unsplit * write5Rate) / 1e6;
    const outputUSD = output * outRate / 1e6;
    // Only explicit token-class tariffs count toward coverage; unknown TTL is estimated.
    const pricedRead = (base.cacheReadPerMillion ?? base.cachedInputPerMillion) !== undefined && (!tier || tier.cacheReadPerMillion !== undefined) ? read : 0;
    const pricedFive = base.cacheWrite5mPerMillion !== undefined && (!tier || tier.cacheWrite5mPerMillion !== undefined) ? write5 : 0;
    const pricedHour = base.cacheWrite1hPerMillion !== undefined && !base.assumptions?.includes('anthropic-cache-1h-2x') && (!tier || tier.cacheWrite1hPerMillion !== undefined) ? write1 : 0;
    const pricedTokens = input + pricedRead + pricedFive + pricedHour + output;
    const { rate, ...provenance } = selected;
    return { costUSD: inputUSD + cacheReadUSD + cacheWriteUSD + outputUSD, inputUSD, cacheReadUSD, cacheWriteUSD, outputUSD, priced: true, pricedTokens, provenance, tierAboveInputTokens: tier?.aboveInputTokens ?? null };
  };
}

let defaultPricer;
export function price(model, usage, timestamp) {
  defaultPricer ??= createPricer(loadReferencePricing());
  return defaultPricer(model, usage, timestamp);
}
