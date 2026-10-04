import assert from 'node:assert/strict';
import test from 'node:test';
import { projectModelId } from '../../src/public/model-id.js';
import { findModelRate } from '../../src/pricing/aliases.ts';
import { modelName } from '../../src/providers/common.ts';
import type { ModelRate } from '../../src/types.ts';
const rates: Record<string, ModelRate> = {
  'claude-opus-4-6': { provider: 'claude', inputPerMillion: 5, cacheReadPerMillion: 0.5,
    cacheWrite5mPerMillion: 6.25, cacheWrite1hPerMillion: 10, outputPerMillion: 25, source: 'https://example.invalid/pricing' },
};
test('PRICING-1M-ALIAS: supported Claude context suffix retains model identity', () => {
  assert.equal(projectModelId('claude-opus-4-6[1m]'), 'claude-opus-4-6');
  assert.equal(projectModelId('anthropic/claude-opus-4-6[1m]'), 'anthropic/claude-opus-4-6');
  assert.equal(projectModelId('claude-opus-4-6[PRIVATE_SENTINEL]'), '<unknown>');
  assert.equal(projectModelId('gpt-fixture[1m]'), '<unknown>');
});
test('PRICING-1M-ALIAS: context suffix resolves tariff and preserves strict variant rejection', () => {
  for (const model of ['claude-opus-4-6[1m]', 'anthropic/claude-opus-4.6[1m]', 'claude-opus-4-6-20260205[1m]']) {
    assert.equal(findModelRate(rates,model)?.rate.inputPerMillion,5);
  }
  assert.equal(findModelRate(rates,'claude-opus-4-6[2m]'),undefined);
  assert.equal(findModelRate(rates,'openai/claude-opus-4-6[1m]'),undefined);
});

test('PRICING-1M-ALIAS: additional-provider model projection keeps only the supported Claude context identity', () => {
  for (const [selector,model] of [
    ['claude-opus-4-6[1m]','claude-opus-4-6'],
    ['anthropic/claude-opus-4.6[1m]','anthropic/claude-opus-4.6'],
  ]) {
    assert.equal(modelName(selector),model);
    assert.equal(findModelRate(rates,modelName(selector))?.rate.inputPerMillion,5);
  }
  for (const invalid of ['claude-opus-4-6[PRIVATE_SENTINEL]', 'gpt-fixture[1m]',
    'reseller/claude-opus-4-6[1m]', 'openai/claude-opus-4-6[1m]',
    'claude-opus-4-6[1m][1m]', '/PRIVATE_SENTINEL/claude-opus-4-6[1m]',
    'claude-PRIVATE_SENTINEL.json[1m]', null, { model: 'claude-opus-4-6[1m]' }]) {
    assert.equal(modelName(invalid),'<unknown>');
  }
  // Preserve existing exact third-party identities; never turn them into direct API aliases.
  assert.equal(modelName('bedrock/anthropic.claude-opus-4-6-v1:0'),'bedrock/anthropic.claude-opus-4-6-v1:0');
  assert.equal(modelName('@cf/meta/llama-4'),'@cf/meta/llama-4');
});
