/** Corroborating cross-provider attribution audit. Raw paths/IDs stay in memory. */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadNativeHeads } from './native-heads.ts';
import { loadConductor } from './conductor-oracle.ts';
import { NO_REPOSITORY_NAME, canonicalizeRemote, resolveRepository } from './git-oracle.ts';
const hash=(s:string,n=12)=>createHash('sha256').update(s).digest('hex').slice(0,n);
const home=homedir();const snapshot=JSON.parse(readFileSync(join(home,'session-analytics-lanes/reference/snapshot-noindex-51ea561.json'),'utf8'));
const prior=JSON.parse(readFileSync('.lane/repos-oracle.json','utf8'));
const cutoff=Date.parse(snapshot.generatedAt);
const native=await loadNativeHeads(home);
const conductor=loadConductor(home);
const snapshotByKey=new Map<string,any>(snapshot.sessions.map((s:any)=>[s.sessionKey,s]));
const priorByKey=new Map<string,any>(prior.rows.map((r:any)=>[r.sessionKey,r]));
const repositoryLabels=new Map<string,string>(snapshot.repositories.map((r:any)=>[r.repository.id,r.repository.name]));
const repoIdentities=new Map<string,Set<string>>();
for(const r of conductor.repos){
 const g=resolveRepository(r.root_path);const remotes=[canonicalizeRemote(r.remote_url),g.remote].filter((x):x is string=>!!x);
 for(const remote of remotes){const ids=repoIdentities.get(remote)||new Set<string>();ids.add('conductor-'+hash('conductor:'+r.id,20));repoIdentities.set(remote,ids);}
}
const providerDB=new Map<string,string[]>();
for(const r of conductor.sessions)if(r.claude_session_id){const key=r.agent_type+':'+r.claude_session_id;providerDB.set(key,[...(providerDB.get(key)||[]),hash(r.id)]);}
function snapshotRows(provider:string,id:string):any[]{
 return [...new Set([hash(provider+':'+id),...(providerDB.get(provider+':'+id)||[])])].flatMap(key=>snapshotByKey.has(key)?[snapshotByKey.get(key)]:[]);
}
interface Support { key:string; remote:string; at:number; snapshot?:any }
const evidence=new Map<string,Support[]>();let excludedNoTime=0,excludedAfterCutoff=0;
for(const r of native.records){
 if(r.provider!=='codex'||!r.cwd)continue;const remote=canonicalizeRemote(r.initialMetadataRemote);if(!remote)continue;
 const at=Date.parse(r.firstAt||'');if(!Number.isFinite(at)){excludedNoTime++;continue;}if(at>cutoff){excludedAfterCutoff++;continue;}
 const list=evidence.get(r.cwd)||[];list.push({key:hash('codex:'+r.id),remote,at,snapshot:snapshotRows('codex',r.id)[0]});evidence.set(r.cwd,list);
}
const conflicts=[...evidence.values()].filter(rows=>new Set(rows.map(r=>r.remote)).size>1);
const rows:any[]=[];const ambiguousTargets:any[]=[];const seen=new Set<string>();
for(const r of native.records){
 if(r.provider!=='claude'||!r.cwd||r.initialMetadataRemote)continue;
 const support=evidence.get(r.cwd);if(!support?.length)continue;
 const g=resolveRepository(r.cwd);if(g.confidence!=='unresolved')continue;
 for(const s of snapshotRows('claude',r.id)){
  if(seen.has(s.sessionKey))continue;seen.add(s.sessionKey);
  if(repositoryLabels.get(s.repositoryId)!==NO_REPOSITORY_NAME)continue;
  if(priorByKey.get(s.sessionKey)?.active)continue;
  const remoteSet=new Set(support.map(x=>x.remote));
  if(remoteSet.size!==1){ambiguousTargets.push({sessionKey:s.sessionKey,cwdHash:hash(r.cwd),supportCount:support.length,remoteCount:remoteSet.size,costUsd:s.cost.totalUsd,inputTokens:s.tokens.inputTokens,outputTokens:s.tokens.outputTokens});continue;}
  const remote=[...remoteSet][0]!;const repositories=[...(repoIdentities.get(remote)||[])];
  if(repositories.includes(s.repositoryId))continue;
  const start=Date.parse(s.firstEventAt||s.createdAt);const end=Date.parse(s.lastEventAt||s.updatedAt||s.firstEventAt||s.createdAt);
  const temporal=support.map(source=>{
   const metadataGapMs=source.at<start?start-source.at:source.at>end?source.at-end:0;
   const sourceStart=Date.parse(source.snapshot?.firstEventAt||source.snapshot?.createdAt||new Date(source.at).toISOString());
   const sourceEnd=Date.parse(source.snapshot?.lastEventAt||source.snapshot?.updatedAt||new Date(source.at).toISOString());
   const activityGapMs=sourceEnd<start?start-sourceEnd:sourceStart>end?sourceStart-end:0;
   return {supportSessionKey:source.key,metadataAt:new Date(source.at).toISOString(),supportFirstAt:new Date(sourceStart).toISOString(),supportLastAt:new Date(sourceEnd).toISOString(),metadataGapHours:metadataGapMs/3_600_000,activityGapHours:activityGapMs/3_600_000,metadataRelation:source.at<start?'before':source.at>end?'after':'during',metadataStartGapHours:Math.abs(source.at-start)/3_600_000,inReference:!!source.snapshot};
  }).sort((a,b)=>a.metadataGapHours-b.metadataGapHours||a.metadataStartGapHours-b.metadataStartGapHours);
  const nearest=temporal[0]!;const nearestActivity=[...temporal].sort((a,b)=>a.activityGapHours-b.activityGapHours||a.metadataGapHours-b.metadataGapHours)[0]!;
  rows.push({sessionKey:s.sessionKey,provider:'claude',cwdHash:hash(r.cwd),remoteHash:hash(remote),actualRepositoryId:s.repositoryId,corroboratedRepositoryIds:repositories,missingCwd:!g.directoryExists,metadataSupportCount:support.length,metadataIdentityCount:remoteSet.size,firstAt:new Date(start).toISOString(),lastAt:new Date(end).toISOString(),month:new Date(start).toISOString().slice(0,7),costUsd:s.cost.totalUsd,inputTokens:s.tokens.inputTokens,outputTokens:s.tokens.outputTokens,tokens:s.tokens.inputTokens+s.tokens.outputTokens,nearestMetadata:nearest,nearestActivity,within24Hours:nearest.metadataGapHours<=24,within7Days:nearest.metadataGapHours<=168,activityOverlap:nearestActivity.activityGapHours===0});
 }
}
const sum=(items:any[])=>({sessions:items.length,costUsd:items.reduce((n,r)=>n+r.costUsd,0),inputTokens:items.reduce((n,r)=>n+r.inputTokens,0),outputTokens:items.reduce((n,r)=>n+r.outputTokens,0),tokens:items.reduce((n,r)=>n+(r.tokens??r.inputTokens+r.outputTokens),0)});
const result={generatedAt:new Date().toISOString(),referenceGeneratedAt:snapshot.generatedAt,method:'exact-cwd-initial-Codex-metadata-before-cutoff-only',status:'corroboration-not-confirmed-reassignment',nativeHeadCounts:native.counts,metadataCwds:evidence.size,conflictingCwds:conflicts.length,excludedMetadataNoTimestamp:excludedNoTime,excludedMetadataAfterCutoff:excludedAfterCutoff,additionalCandidates:sum(rows),within24Hours:sum(rows.filter(r=>r.within24Hours)),within7Days:sum(rows.filter(r=>r.within7Days)),overlappingReferenceActivity:sum(rows.filter(r=>r.activityOverlap)),registeredCandidates:sum(rows.filter(r=>r.corroboratedRepositoryIds.length===1)),ambiguousExcluded:sum(ambiguousTargets),groups:[...new Set(rows.map(r=>r.cwdHash))].map(cwdHash=>{const rs=rows.filter(r=>r.cwdHash===cwdHash);return {cwdHash,remoteHash:rs[0]?.remoteHash,...sum(rs),months:[...new Set(rs.map(r=>r.month))].sort(),minMetadataGapHours:Math.min(...rs.map(r=>r.nearestMetadata.metadataGapHours)),maxMetadataGapHours:Math.max(...rs.map(r=>r.nearestMetadata.metadataGapHours)),maxActivityGapHours:Math.max(...rs.map(r=>r.nearestActivity.activityGapHours))};}),rows,ambiguousTargets};
writeFileSync('.lane/shared-cwd-evidence.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({headCounts:result.nativeHeadCounts,metadataCwds:result.metadataCwds,conflictingCwds:result.conflictingCwds,additionalCandidates:result.additionalCandidates,within24Hours:result.within24Hours,within7Days:result.within7Days,overlappingReferenceActivity:result.overlappingReferenceActivity,registeredCandidates:result.registeredCandidates,ambiguousExcluded:result.ambiguousExcluded,groups:result.groups},null,2));
