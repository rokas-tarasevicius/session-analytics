/** The one index deferral warning is operational evidence, never a generic waiver. */
const warning='Evidence changed during analysis; unstable index groups were deferred until the next scan.';
type Row=Record<string,any>;
export function proveDeferralWarning(snapshot:Row,index:Row|null,changed:ReadonlySet<string>){
  const present=snapshot.warnings.filter((w:unknown)=>w===warning).length;
  const sessions=snapshot.sessions.filter((s:Row)=>changed.has(s.sessionKey)).map((s:Row)=>s.sessionKey).sort();
  const failures:string[]=[],deferred=index?.['deferredSessions']??0;
  if(!Number.isSafeInteger(deferred)||deferred<0||present>1||Boolean(present)!==Boolean(deferred)||deferred>sessions.length)failures.push('warnings.unproved-index-deferral');
  for(const repo of snapshot.repositories)if(repo.warnings.filter((w:unknown)=>w===warning).length!==present)failures.push('warnings.repository-deferral-disagreement');
  if(failures.length||!present)return{snapshot,accepted:[],failures};
  return{snapshot:{...snapshot,warnings:snapshot.warnings.filter((w:unknown)=>w!==warning),repositories:snapshot.repositories.map((r:Row)=>({...r,warnings:r.warnings.filter((w:unknown)=>w!==warning)}))},accepted:[{warning,deferredSessions:deferred,independentlyChangedSessionKeys:sessions}],failures};
}
