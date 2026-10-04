import { createHash } from 'node:crypto';
import type { ModelRate, RateProvenance } from '../types.ts';

type Resolution = { rate: ModelRate; provenance: RateProvenance };
interface ReviewedInterval {
  model: string; from: string; until: string;
  current: readonly [number, number, number]; historical: readonly [number, number, number];
  source: string;
}
// These are model-specific effective intervals, not purported historical copies
// of the entire current rate card. Official dates are day-granular. Terra's old
// amounts are inferred from the published 20% reduction; review before landing.
const history: readonly ReviewedInterval[] = [
  { model: 'gpt-5.6-sol', from: '2026-07-09T00:00:00.000Z', until: '2026-08-21T00:00:00.000Z',
    current: [4, 0.4, 20], historical: [5, 0.5, 30], source: 'https://developers.openai.com/api/docs/changelog' },
  { model: 'gpt-5.6-terra', from: '2026-07-09T00:00:00.000Z', until: '2026-07-30T00:00:00.000Z',
    current: [2, 0.2, 12], historical: [2.5, 0.25, 15], source: 'https://developers.openai.com/api/docs/changelog' },
];

export function applyBundledReviewedHistory(resolution: Resolution, timestamp: string | null | undefined): Resolution {
  const time = timestamp ? Date.parse(timestamp) : NaN;
  if (!Number.isFinite(time) || resolution.provenance.source !== 'reviewed' || resolution.provenance.temporal !== 'oldest') return resolution;
  const interval = history.find(h => h.model === resolution.provenance.rateModel &&
    Date.parse(h.from) <= time && time < Date.parse(h.until));
  if (!interval) return resolution;
  const base = resolution.rate;
  // Do not overwrite an explicit older reviewed tariff or a later changed card.
  if (base.inputPerMillion !== interval.current[0] ||
      (base.cachedInputPerMillion ?? base.cacheReadPerMillion) !== interval.current[1] ||
      base.outputPerMillion !== interval.current[2]) return resolution;
  const rate: ModelRate = { ...base, source: interval.source, inputPerMillion: interval.historical[0],
    cachedInputPerMillion: interval.historical[1], outputPerMillion: interval.historical[2] };
  if (base.cacheWrite5mPerMillion !== undefined && base.inputPerMillion > 0) {
    rate.cacheWrite5mPerMillion = base.cacheWrite5mPerMillion * interval.historical[0] / base.inputPerMillion;
  }
  const payloadSha256 = createHash('sha256').update(JSON.stringify({
    basePayloadSha256: resolution.provenance.payloadSha256, interval,
  })).digest('hex');
  return { rate, provenance: { ...resolution.provenance, payloadSha256,
    snapshotDate: interval.from, temporal: 'at-or-before' } };
}
