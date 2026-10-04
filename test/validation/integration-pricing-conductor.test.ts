import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addUsage, emptySession, zeroTokens } from '../../src/providers/common.ts';
import { priceUsage } from '../../src/pricing/usage.ts';
import { conductorFallback } from '../../src/providers/conductor.ts';
import { normalizeSource } from '../../src/pricing/sources.ts';
import { findModelRate } from '../../src/pricing/aliases.ts';
import { loadPricingCatalog, resolveRate } from '../../src/pricing/catalog.ts';
import type { ModelRate, SessionDatabaseRow } from '../../src/types.ts';

test('INTEGRATION-PRICE-01: impossible context tiers do not inflate a small aggregate upper bound', () => {
  const rate: ModelRate = { provider: 'cursor', inputPerMillion: 1, outputPerMillion: 2, source: 'https://example.com/prices', contextTiers: [{ aboveInputTokens: 200000, inputPerMillion: 10, outputPerMillion: 20 }] };
  const context = { repository: { id: 'synthetic', name: 'Synthetic' }, rateCard: { currency: 'USD' as const, effectiveDate: '2026-01-01', models: { 'grok-synthetic': rate } }, price: (r: ModelRate, u: ReturnType<typeof zeroTokens>, size: number) => priceUsage(r,u,size).cost };
  const s = emptySession({ id: 'synthetic', path: '', cwd: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }, 'cursor', context, { source: 'cursor-sdk', fidelity: 'summary', tokens: 'reported', tools: 'unavailable', turns: 'unavailable', timing: 'provider', usageUnit: 'run' });
  addUsage(s, context, 'grok-synthetic', { ...zeroTokens(), inputTokens: 100, uncachedInputTokens: 100, outputTokens: 10, nonReasoningOutputTokens: 10 }, null, 'summary');
  assert.equal(s.cost.upperEstimateUsd, s.cost.totalUsd);
});

test('INTEGRATION-CONDUCTOR-01: marginal value evidence cannot make incomplete token epochs complete', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE session_messages (id TEXT, session_id TEXT, content TEXT, created_at TEXT)');
  const row: SessionDatabaseRow = { agent_type:'claude', branch:null, conductor_session_id:'synthetic-conductor', created_at:'2026-07-01T10:00:00Z', database_model:'claude-opus-4-6', default_branch:'main', is_hidden:0, provider_session_id:'synthetic-provider', repository_id:'synthetic-repository', repository_name:'Synthetic', repository_remote:'',root_path:'/synthetic',status:'idle',title:'synthetic',updated_at:'2026-07-01T11:00:00Z', workspace_name:null,workspace_path:'/synthetic/workspace' };
  const insert = db.prepare('INSERT INTO session_messages VALUES (?,?,?,?)');
  for (const [i,cost,input,marginal] of [[0,10,100,10],[1,15,150,5]]) {
    insert.run(`init-${i}`, row.conductor_session_id, JSON.stringify({ type:'system',subtype:'init',uuid:`init-${i}`,claude_code_version:'2.1.100' }),`2026-07-01T10:0${i}:00Z`);
    insert.run(`result-${i}`, row.conductor_session_id, JSON.stringify({ type:'result',subtype:'success',uuid:`receipt-${i}`,session_id:row.provider_session_id,total_cost_usd:cost,modelUsage:{'claude-opus-4-6':{inputTokens:input,outputTokens:0,costUSD:cost}},conductor_sdk_metadata:{marginalCostUsd:marginal} }),`2026-07-01T10:0${i}:01Z`);
  }
  try {
    const s=conductorFallback(db,[row],new Set(),{ rateCard:{currency:'USD',effectiveDate:'2026-01-01',models:{}},price:()=>{throw Error('unused');} })[0]!;
    assert.equal(s.cost.totalUsd,15); assert.equal(s.evidence!.accounting,'partial'); assert.equal(s.costComplete,false);
  } finally { db.close(); }
});

test('INTEGRATION-PRICE-02: api-first fallback retains historical reviewed tariff', async () => {
  const c = await loadPricingCatalog({ pricingPolicy:'api-first', offline:true, dataDir:join(tmpdir(),'v061-no-pricing-cache') });
  assert.equal(resolveRate(c,'gpt-5.6-sol','2026-08-20T12:00:00Z')!.rate.inputPerMillion,5);
});

test('INTEGRATION-PRICE-03: new xAI support keeps contradictory OpenAI prefixes rejected', () => {
  const models = normalizeSource('models.dev',{xai:{models:{'grok-valid':{cost:{input:1,output:2}},'openai/grok-synthetic':{cost:{input:1,output:2}}}}}).models;
  assert.deepEqual(Object.keys(models), ['grok-valid']);
  const rate: ModelRate = { provider:'cursor',inputPerMillion:1,outputPerMillion:2,source:'https://example.com/prices' };
  assert.equal(findModelRate({'grok-synthetic':rate},'openai/grok-synthetic'), undefined);
});
