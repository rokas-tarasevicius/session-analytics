import assert from 'node:assert/strict';
import test from 'node:test';
import { findModelRate } from '../../src/pricing/aliases.ts';
import { normalizeSource } from '../../src/pricing/sources.ts';
import type { ModelRate } from '../../src/types.ts';

const claude: ModelRate = { provider: 'claude', inputPerMillion: 7, outputPerMillion: 35, source: 'https://example.invalid/pricing' };
const codex: ModelRate = { provider: 'codex', inputPerMillion: 9, outputPerMillion: 45, source: 'https://example.invalid/pricing' };
test('PRICING-LAB-PREFIX: rejected cross-lab IDs cannot reenter through unprefixed aliases', () => {
  const models = { 'openai/claude-fixture': claude, 'anthropic/gpt-fixture': codex };
  assert.equal(findModelRate(models, 'openai/claude-fixture'), undefined);
  assert.equal(findModelRate(models, 'anthropic/gpt-fixture'), undefined);
  assert.equal(findModelRate(models, 'claude-fixture'), undefined);
  assert.equal(findModelRate(models, 'gpt-fixture'), undefined);
});
test('PRICING-LAB-PREFIX: models.dev rejects contradictory lab identity', () => {
  const normalized = normalizeSource('models.dev', {
    anthropic: { models: {
      'openai/claude-fixture': { cost: { input: 7, output: 35 } },
      'claude-safe-fixture': { cost: { input: 3, output: 15 } },
    } },
    openai: { models: {
      'anthropic/gpt-fixture': { cost: { input: 9, output: 45 } },
      'gpt-safe-fixture': { cost: { input: 2, output: 10 } },
    } },
  });
  assert.deepEqual(Object.keys(normalized.models).sort(), ['claude-safe-fixture','gpt-safe-fixture']);
});
test('PRICING-LAB-PREFIX: LiteLLM rejects contradictory lab identity', () => {
  const normalized = normalizeSource('litellm', {
    'openai/claude-fixture': { litellm_provider: 'anthropic', input_cost_per_token: 7e-6, output_cost_per_token: 35e-6 },
    'anthropic/gpt-fixture': { litellm_provider: 'openai', input_cost_per_token: 9e-6, output_cost_per_token: 45e-6 },
    'gpt-safe-fixture': { litellm_provider: 'openai', input_cost_per_token: 2e-6, output_cost_per_token: 10e-6 },
  });
  assert.deepEqual(Object.keys(normalized.models), ['gpt-safe-fixture']);
});
