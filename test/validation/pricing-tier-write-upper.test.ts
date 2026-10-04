import assert from 'node:assert/strict';
import test from 'node:test';
import { priceUsage } from '../../src/pricing/usage.ts';
import { validateRate } from '../../src/pricing/validation.ts';
import type { ModelRate, TokenUsage } from '../../src/types.ts';

const usage: TokenUsage = { inputTokens: 1_000_000, uncachedInputTokens: 1_000_000,
  cachedInputTokens: 0, cacheWriteInputTokens: 0, cacheWrite5mInputTokens: 0, cacheWrite1hInputTokens: 0,
  outputTokens: 0, reasoningOutputTokens: 0, nonReasoningOutputTokens: 0 };
const base: ModelRate = { provider: 'codex', inputPerMillion: 4, outputPerMillion: 10,
  cacheWrite5mPerMillion: 5, cacheWriteObservable: false, cacheWriteMultiplier: 1.25,
  source: 'https://example.invalid/pricing' };
const contextual = (write: number | undefined, multiplier = 1.25): ModelRate => validateRate({ ...base, cacheWriteMultiplier: multiplier,
  contextTiers: [{ aboveInputTokens: 272_000, inputPerMillion: 8, outputPerMillion: 15,
    ...(write === undefined ? {} : { cacheWrite5mPerMillion: write }) }] });

test('PRICING-TIER-WRITE-UPPER: explicit tier write tariff overrides the base write multiplier', () => {
  const result=priceUsage(contextual(20),usage,usage.inputTokens);
  assert.equal(result.cost.totalUsd,8);
  assert.equal(result.cost.upperEstimateUsd,20);
  assert.equal(result.pricedTokens,1_000_000);
  assert.deepEqual(result.assumptions,['cache-write-upper-multiplier']);
});

test('PRICING-TIER-WRITE-UPPER: label follows actual tier premium, not configured base multiplier', () => {
  const result=priceUsage(contextual(10,2),usage,usage.inputTokens);
  assert.equal(result.cost.upperEstimateUsd,10);
  assert.deepEqual(result.assumptions,['codex-cache-write-upper-1.25x']);
});

for(const write of [0,5])test(`PRICING-TIER-WRITE-UPPER: write tariff ${write} below input cannot lower or inflate upper value`, () => {
  const result=priceUsage(contextual(write),usage,usage.inputTokens);
  assert.equal(result.cost.upperEstimateUsd,result.cost.totalUsd);
  assert.deepEqual(result.assumptions,[]);
});

test('PRICING-TIER-WRITE-UPPER: missing tier write uses base cache fallback and clamps at ordinary value', () => {
  const result=priceUsage(contextual(undefined),usage,usage.inputTokens);
  assert.equal(result.cost.upperEstimateUsd,8);
  assert.deepEqual(result.assumptions,[]);
});

test('PRICING-TIER-WRITE-UPPER: explicit write tariff applies when no multiplier is configured', () => {
  const rate=validateRate({ ...base, cacheWriteMultiplier: undefined, cacheWrite5mPerMillion:10 });
  const result=priceUsage(rate,usage,usage.inputTokens);
  assert.equal(result.cost.totalUsd,4);
  assert.equal(result.cost.upperEstimateUsd,10);
  assert.deepEqual(result.assumptions,['cache-write-upper-multiplier']);
});

test('PRICING-TIER-WRITE-UPPER: zero base tariff with positive explicit write price has a finite upper bound', () => {
  const rate=validateRate({ ...base,inputPerMillion:0 });
  const result=priceUsage(rate,usage,usage.inputTokens);
  assert.equal(result.cost.totalUsd,0);
  assert.equal(result.cost.upperEstimateUsd,5);
  assert.deepEqual(result.assumptions,['cache-write-upper-multiplier']);
});

test('PRICING-TIER-WRITE-UPPER control: no explicit write retains configured multiplier and observed writes get no second charge', () => {
  const rate=validateRate({ ...base,cacheWrite5mPerMillion:undefined });
  assert.equal(priceUsage(rate,usage,usage.inputTokens).cost.upperEstimateUsd,5);
  const observed={ ...usage,uncachedInputTokens:0,cacheWriteInputTokens:1_000_000,cacheWrite5mInputTokens:1_000_000 };
  const result=priceUsage(validateRate(base),observed,observed.inputTokens);
  assert.equal(result.cost.totalUsd,5);
  assert.equal(result.cost.upperEstimateUsd,5);
  assert.deepEqual(result.assumptions,[]);
});
