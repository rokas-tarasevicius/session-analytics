import test from'node:test';import assert from'node:assert/strict';import{verifyInventoryCoverage,verifyPhaseInventory,type InventoryCapture}from'../scripts/verify-real-inventory-evidence.ts';
function capture():InventoryCapture{
 const scope=(key:string,repositoryId:string|null,provider:'claude'|'codex'='codex')=>({key:Buffer.from(key).toString('hex').padEnd(64,'0'),repositoryId,provider,generation:'a'.repeat(64),status:'absent' as const});
 return{globalRoots:3,rootCoverage:[{repositoryId:'repo',candidates:1,status:'resolved'}],discoveryFailures:[],alternatives:[],census:{capturedAt:'2026-01-01T00:00:00Z',scopes:[scope('one',null,'claude'),scope('two',null),scope('three',null),...['four','five','six'].map(k=>scope(k,'repo'))],members:[],failures:[]}};
}
const snapshot={generatedAt:'2026-01-01T00:00:00Z',repositories:[{repository:{id:'repo'}}],workflow:{installedSkills:[]}};
test('every phase requires independent nonempty global discovery and every selected repository scope',()=>{
 const proof=capture();assert.deepEqual(verifyPhaseInventory(snapshot,proof,proof).failures,[]);
 assert.ok(verifyInventoryCoverage(snapshot,{...proof,globalRoots:0}).length);
 assert.ok(verifyInventoryCoverage(snapshot,{...proof,rootCoverage:[]}).length);
 assert.ok(verifyInventoryCoverage(snapshot,{...proof,discoveryFailures:['repository:repo:missing']}).length);
 assert.ok(verifyInventoryCoverage(snapshot,{...proof,discoveryFailures:['arbitrary-discovery-failure']}).length);
 const bad=capture();bad.census.members.push({name:'phantom',provider:'codex',repositoryId:null,key:'b'.repeat(64),generation:'c'.repeat(64),sourceKeys:['two']});assert.ok(verifyPhaseInventory(snapshot,bad,bad).failures.length);
});
test('ambiguous roots need every independently observed candidate and zero equivalence failures',()=>{
 const proof=capture();proof.rootCoverage[0]={repositoryId:'repo',candidates:2,status:'ambiguous'};proof.discoveryFailures=['repository:repo:ambiguous'];
 assert.ok(verifyInventoryCoverage(snapshot,proof).length);proof.alternatives=[{repositoryId:'repo',candidates:2}];
 proof.census.scopes.push(...['seven','eight','nine'].map(key=>({key:Buffer.from(key).toString('hex').padEnd(64,'0'),provider:'codex' as const,repositoryId:'repo',generation:'a'.repeat(64),status:'absent' as const})));
 assert.deepEqual(verifyInventoryCoverage(snapshot,proof),[]);proof.census.failures=['repository:repo:alternative-inventory-mismatch'];assert.ok(verifyInventoryCoverage(snapshot,proof).length);
});
test('only explicitly discovered unused repository failures are projected out',async()=>{
 const{createHash}=await import('node:crypto');const hash=(id:string)=>createHash('sha256').update(JSON.stringify(id)).digest('hex');
 const proof=capture();proof.rootCoverage.push({repositoryId:'unused',candidates:81,status:'ambiguous'});proof.alternatives.push({repositoryId:'unused',candidates:81});proof.discoveryFailures.push('repository:unused:ambiguous');proof.census.failures.push(`repository:${hash('unused')}:ambiguous-membership`);
 const result=verifyPhaseInventory(snapshot,proof,proof);assert.deepEqual(result.failures,[]);assert.equal(result.outOfScopeFailures.before.length,2);assert.equal(proof.census.failures.length,1);
 const active=capture();active.census.failures.push(`repository:${hash('repo')}:ambiguous-membership`);assert.ok(verifyPhaseInventory(snapshot,active,active).failures.length);
 for(const failure of [`repository:${hash('unknown')}:ambiguous-membership`,'global:unavailable',`scope:${'a'.repeat(64)}:unavailable`]){const changed=structuredClone(proof);changed.census.failures.push(failure);assert.ok(verifyPhaseInventory(snapshot,changed,changed).failures.length);}
 const unknown=capture();unknown.discoveryFailures.push('repository:unknown:ambiguous');assert.ok(verifyPhaseInventory(snapshot,unknown,unknown).failures.length);
});

test('scope projection cannot hide malformed stored observations belonging to unused repositories',()=>{
 const proof=capture();proof.rootCoverage.push({repositoryId:'unused',candidates:1,status:'resolved'});
 proof.census.scopes.push({key:'f'.repeat(64),generation:'a'.repeat(64),provider:'codex',repositoryId:'unused',status:'absent'});
 assert.deepEqual(verifyPhaseInventory(snapshot,proof,proof).failures,[]);
 for(const value of [undefined,'not-a-generation',17]){
  const malformed=structuredClone(proof);
  (malformed.census.scopes.at(-1)! as unknown as Record<string,unknown>)['generation']=value;
  assert.ok(verifyPhaseInventory(snapshot,malformed,malformed).failures.length,'unused malformed scope must stay fatal');
 }
 const untyped=structuredClone(proof);(untyped.census.failures as unknown[]).push(17);
 assert.ok(verifyPhaseInventory(snapshot,untyped,untyped).failures.length,'failure records must be typed before filtering');
});
test('the rootless no-repository group passes only with no candidates and no repository scopes',()=>{
 const withGroup={...snapshot,repositories:[...snapshot.repositories,{repository:{id:'bucket'}}]};
 const proof=capture();proof.rootCoverage.push({repositoryId:'bucket',candidates:0,status:'rootless'});
 assert.deepEqual(verifyPhaseInventory(withGroup,proof,proof).failures,[]);
 const scoped=capture();scoped.rootCoverage.push({repositoryId:'bucket',candidates:0,status:'rootless'});
 scoped.census.scopes.push({key:'f'.repeat(64),repositoryId:'bucket',provider:'claude',generation:'a'.repeat(64),status:'absent'});
 assert.ok(verifyInventoryCoverage(withGroup,scoped).length,'a rootless group must not own repository skills');
 const counted=capture();counted.rootCoverage.push({repositoryId:'bucket',candidates:1,status:'rootless'});
 assert.ok(verifyInventoryCoverage(withGroup,counted).length,'a rootless group cannot have a candidate root');
 const missing=capture();missing.rootCoverage.push({repositoryId:'bucket',candidates:0,status:'missing'});
 assert.ok(verifyInventoryCoverage(withGroup,missing).length);
});
