/** Independent root discovery certificate plus content-free inventory observations. */
import { createHash } from 'node:crypto';
import { loadInventorySkillRoots, type InventoryRootCoverage } from '../verify/repos/inventory-roots.ts';
import { captureSupportedInventory, verifyInventorySnapshot, validInventoryCensus, type InventoryCensus } from './verify-real-inventory.ts';
type Row=Record<string,any>;
export interface InventoryCapture { census:InventoryCensus; rootCoverage:InventoryRootCoverage[]; discoveryFailures:string[]; globalRoots:number; alternatives:{repositoryId:string;candidates:number}[] }
export async function captureInventoryEvidence():Promise<InventoryCapture>{
 const bridge=await loadInventorySkillRoots();
 const census=await captureSupportedInventory(bridge.roots,bridge.alternatives);
 return{census,rootCoverage:bridge.coverage,discoveryFailures:bridge.failures,globalRoots:bridge.roots.filter(r=>r.repositoryId===null).length,alternatives:bridge.alternatives.map(r=>({repositoryId:r.repositoryId,candidates:r.candidates.length}))};
}
/** Discovery precedes the first analyzer phase, so it includes historical roots
 * absent from the phase. Preserve those observations in the saved capture and
 * scope only independently identified repository failures to the public cohort.
 * Unknown failure shapes and global failures always remain fatal. */
export function scopeInventoryEvidence(snapshot:Row,capture:InventoryCapture):InventoryCapture & {outOfScopeFailures:string[]}{
 const id=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
 if(!validInventoryCensus(capture.census,true)||!Array.isArray(capture.rootCoverage)||!Array.isArray(capture.discoveryFailures)||!capture.discoveryFailures.every(f=>typeof f==='string')||!Array.isArray(capture.alternatives)||
  !capture.rootCoverage.every(r=>r&&id(r.repositoryId)&&Number.isSafeInteger(r.candidates)&&((r.status==='resolved'&&r.candidates===1)||(r.status==='missing'&&r.candidates===0)||(r.status==='rootless'&&r.candidates===0)||(r.status==='ambiguous'&&r.candidates>=2)))||new Set(capture.rootCoverage.map(r=>r.repositoryId)).size!==capture.rootCoverage.length||
  !capture.alternatives.every(a=>a&&id(a.repositoryId)&&Number.isSafeInteger(a.candidates)&&a.candidates>=2&&capture.rootCoverage.filter(r=>r.repositoryId===a.repositoryId&&r.status==='ambiguous'&&r.candidates===a.candidates).length===1)||new Set(capture.alternatives.map(a=>a.repositoryId)).size!==capture.alternatives.length)
  return{...capture,census:{...capture.census,failures:['workflow.inventory.complete-capture-invalid']},outOfScopeFailures:[]};
 const selected=new Set(snapshot.repositories.map((r:Row)=>r.repository.id));
 const unused=new Set(capture.rootCoverage.filter(r=>!selected.has(r.repositoryId)).map(r=>r.repositoryId));
 const hashes=new Set(capture.rootCoverage.filter(r=>unused.has(r.repositoryId)&&r.status==='ambiguous'&&r.candidates>=2&&capture.alternatives.filter(a=>a.repositoryId===r.repositoryId&&a.candidates===r.candidates).length===1).map(r=>createHash('sha256').update(JSON.stringify(r.repositoryId)).digest('hex')));
 const outOfScopeFailures:string[]=[];
 const discoveryFailures=capture.discoveryFailures.filter(f=>{
  const match=/^repository:(.+):(missing|ambiguous)$/.exec(f),row=match&&capture.rootCoverage.find(r=>r.repositoryId===match[1]);
  if(row&&unused.has(row.repositoryId)&&row.status===match![2]&&((row.status==='missing'&&row.candidates===0)||(row.status==='ambiguous'&&row.candidates>=2&&capture.alternatives.filter(a=>a.repositoryId===row.repositoryId&&a.candidates===row.candidates).length===1))){outOfScopeFailures.push(f);return false;}
  return true;
 });
 const failures=capture.census.failures.filter(f=>{const match=/^repository:([a-f0-9]{64}):ambiguous-membership$/.exec(f);if(match&&hashes.has(match[1]!)){outOfScopeFailures.push(f);return false;}return true;});
 return{...capture,discoveryFailures,census:{...capture.census,scopes:capture.census.scopes.filter(s=>!unused.has(s.repositoryId!)),members:capture.census.members.filter(m=>!unused.has(m.repositoryId!)),failures},outOfScopeFailures:outOfScopeFailures.sort()};
}
export function verifyInventoryCoverage(snapshot:Row,capture:InventoryCapture):string[]{
 const failures:string[]=[];
 if(!capture||!Number.isSafeInteger(capture.globalRoots)||capture.globalRoots<3||!Array.isArray(capture.rootCoverage)||!Array.isArray(capture.discoveryFailures)||!Array.isArray(capture.alternatives)||!Array.isArray(capture.census?.scopes)||!Array.isArray(capture.census.failures))return['workflow.inventory.discovery-unavailable'];
 capture=scopeInventoryEvidence(snapshot,capture);
 if(capture.census.failures.length)failures.push('workflow.inventory.census-failed');
 const global=capture.census.scopes.filter(s=>s.repositoryId===null);if(global.length<capture.globalRoots||!global.some(s=>s.provider==='claude')||!global.some(s=>s.provider==='codex'))failures.push('workflow.inventory.global-discovery');
 const coverage=new Map(capture.rootCoverage.map(r=>[r.repositoryId,r]));if(coverage.size!==capture.rootCoverage.length)failures.push('workflow.inventory.repository-multiplicity');
 for(const repository of snapshot.repositories){
  const id=repository.repository.id,row=coverage.get(id),alternatives=capture.alternatives.filter(r=>r.repositoryId===id),scopes=capture.census.scopes.filter(s=>s.repositoryId===id);
  if(!row||!Number.isSafeInteger(row.candidates)||row.candidates<0){failures.push(`workflow.inventory.repository:${id}:missing`);continue;}
  if(row.status==='resolved'&&row.candidates===1&&scopes.length>=3)continue;
  // The no-repository group owns no directory; any repository-scoped skill there would be a product error.
  if(row.status==='rootless'&&row.candidates===0&&scopes.length===0&&!alternatives.length)continue;
  if(row.status==='ambiguous'&&row.candidates>1&&alternatives.length===1&&alternatives[0]!.candidates===row.candidates&&scopes.length>=row.candidates*3&&!capture.census.failures.length)continue;
  failures.push(`workflow.inventory.repository:${id}:unproved`);
 }
 for(const failure of capture.discoveryFailures){
  const match=/^repository:(.+):(missing|ambiguous)$/.exec(failure);
  if(!match){failures.push('workflow.inventory.discovery-failed');continue;}
  const row=coverage.get(match[1]!);
  if(match[2]!=='ambiguous'||row?.status!=='ambiguous'||!Number.isSafeInteger(row.candidates)||row.candidates<2||capture.alternatives.filter(a=>a.repositoryId===match[1]&&a.candidates===row.candidates).length!==1||capture.census.scopes.filter(s=>s.repositoryId===match[1]).length<row.candidates*3||capture.census.failures.length)failures.push(`workflow.inventory.repository:${match[1]}:discovery-failed`);
 }
 return failures;
}
export function verifyPhaseInventory(snapshot:Row,before:InventoryCapture,after:InventoryCapture){
 const failures=[...verifyInventoryCoverage(snapshot,before),...verifyInventoryCoverage(snapshot,after)];
 const scopedBefore=scopeInventoryEvidence(snapshot,before),scopedAfter=scopeInventoryEvidence(snapshot,after);
 const proof=verifyInventorySnapshot(snapshot,[scopedBefore.census,scopedAfter.census]);
 return{...proof,outOfScopeFailures:{before:scopedBefore.outOfScopeFailures,after:scopedAfter.outOfScopeFailures},failures:[...new Set([...failures,...proof.failures])].sort()};
}
