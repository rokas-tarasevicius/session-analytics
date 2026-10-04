import test from'node:test';import assert from'node:assert/strict';import{proveDeferralWarning}from'../scripts/verify-real-warnings.ts';
const warning='Evidence changed during analysis; unstable index groups were deferred until the next scan.';
test('deferral warning requires both index count and exact changed source session membership',()=>{
 const snapshot={warnings:[warning,'preserved'],sessions:[{sessionKey:'one'},{sessionKey:'two'}],repositories:[{warnings:[warning,'preserved']}]};
 const proved=proveDeferralWarning(snapshot,{deferredSessions:1},new Set(['one']));assert.deepEqual(proved.failures,[]);assert.deepEqual(proved.snapshot.warnings,['preserved']);assert.deepEqual(proved.accepted[0]!.independentlyChangedSessionKeys,['one']);
 assert.equal(proveDeferralWarning(snapshot,{deferredSessions:1},new Set()).failures.length,1);
 assert.equal(proveDeferralWarning(snapshot,{deferredSessions:2},new Set(['one'])).failures.length,1);
 assert.equal(proveDeferralWarning(snapshot,null,new Set(['one'])).failures.length,1);
});
