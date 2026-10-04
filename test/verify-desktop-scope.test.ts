import test from 'node:test';
import assert from 'node:assert/strict';
import { compareDesktopDedup, compareTimeScopes } from '../verify/shared/desktop-scope.ts';
const desktop={intervals:[{sessionKey:'hash',endedAt:'2026-03-05T20:35:00Z',preResumeCarryoverVersion:true,overlappingNativeMessages:0,missingNativeMessages:0,models:[{inputsMatch:true,missingTokens:571,missingApiEquivalentUsd:.008527,delta:{input:232,read:0,write:0,output:339}}]}]};
test('native-only identity totals require the exact independently proved receipt difference',()=>{
  const tokens={inputTokens:-232,uncachedInputTokens:-232,cachedInputTokens:0,cacheWriteInputTokens:0,cacheWrite5mInputTokens:0,cacheWrite1hInputTokens:0,outputTokens:-339,reasoningOutputTokens:0};
  const legacy={tokenMismatches:[{sessionKey:'hash',tokens,dollars:-.008527}]};
  assert.deepEqual(compareDesktopDedup(legacy,desktop).differences,[]);
  assert.equal(compareDesktopDedup({...legacy,tokenMismatches:[{...legacy.tokenMismatches[0],tokens:{...tokens,inputTokens:-233}}]},desktop).differences.length,1);
  assert.equal(compareDesktopDedup({tokenMismatches:[]},desktop).differences.length,1);
});
test('time proof preserves native request denominator and requires complete receipt-only event value',()=>{
  const day='2026-03-05',native={sessions:[{sessionKey:'hash',spendByDay:{[day]:.212088},tokensByDay:{[day]:{inputTokens:86297,outputTokens:22}}}]};
  const snapshot={sessions:[{sessionKey:'hash',limitsCache:{buckets:[{day,apiEquivalentUsd:.212088,observedTokens:86319}]}}]};
  const audit={parityErrors:[{sessionKey:'hash',day,kind:'limits-spend',limitsUsd:.212088,spendUsd:.220615}],discrepancies:[]};
  assert.deepEqual(compareTimeScopes(audit,native,desktop,snapshot).differences,[]);
  const broken=structuredClone(snapshot);broken.sessions[0]!.limitsCache.buckets[0]!.observedTokens++;
  assert.equal(compareTimeScopes(audit,native,desktop,broken).differences.length,1);
  assert.equal(compareTimeScopes({...audit,parityErrors:[]},native,desktop,snapshot).differences.length,1);
});
