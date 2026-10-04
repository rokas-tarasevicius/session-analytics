/** Independent repository attribution audit. No production imports.
 * Raw metadata lives only in memory. The persisted report uses hashes and counters. */
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadNative } from './native-oracle.ts';
import { loadNativeHeads } from './native-heads.ts';
import { loadConductor } from './conductor-oracle.ts';
import { loadCursor } from './cursor-oracle.ts';
import { canonicalizeRemote, localDirectoryAttribution, resolveRepository as resolveUncachedRepository } from './git-oracle.ts';
async function main(): Promise<void> {
const hashCache=new Map<string,string>();
const hash=(s:string,n=12)=>{const key=`${n}:${s}`;let value=hashCache.get(key);if(!value){value=createHash('sha256').update(s).digest('hex').slice(0,n);hashCache.set(key,value);}return value;};
const home=homedir();
const snapshotArgument=process.argv.slice(2).find(value=>!value.startsWith('--'));
const snapshot=JSON.parse(readFileSync(snapshotArgument??join(home,'session-analytics-lanes/reference/snapshot-noindex-51ea561.json'),'utf8'));
const cutoff=snapshot.generatedAt;
const conductor=loadConductor(home);
const prior=process.argv.includes('--reuse-census')?JSON.parse(readFileSync('.lane/repos-oracle-initial.json','utf8')):null;
if(prior&&prior.referenceGeneratedAt!==cutoff)throw new Error('The cached census belongs to a different reference.');
const priorRows=new Map<string,any>((prior?.rows??[]).map((r:any)=>[r.sessionKey,r]));
process.stderr.write(prior?'Rechecking raw identity headers against completed timestamp census.\n':'Scanning raw native metadata.\n');
const native=prior?await loadNativeHeads(home,new Set<string>(prior.missing.filter((r:any)=>r.provider==='codex').map((r:any)=>r.sessionKey))):await loadNative(home);
process.stderr.write(JSON.stringify(native.counts)+'\n');
const cursor=loadCursor(home);
const records:any[]=[...native.records,...cursor];
const repoId=(id:string)=>`conductor-${hash('conductor:'+id,20)}`;
const discoveredId=(root:string)=>`discovered-${hash(root,20)}`;
const canonicalCache=new Map<string,string>();
const canonical=(path:string)=>{if(canonicalCache.has(path))return canonicalCache.get(path)!;let result:string;try{result=realpathSync(path);}catch{result=resolve(path);}canonicalCache.set(path,result);return result;};
const gitCache=new Map<string,ReturnType<typeof resolveUncachedRepository>>();
const resolveRepository=(cwd?:string,remote?:string)=>{const key=JSON.stringify([cwd,remote]);if(!gitCache.has(key))gitCache.set(key,resolveUncachedRepository(cwd,remote));return gitCache.get(key)!;};
const within=(path:string,root:string)=>path===root||path.startsWith(root.replace(/\/$/,'')+'/');
const byIdentity=new Map<string,Set<string>>();const byRepoId=new Map<string,string>();
const repoRoots=new Map<string,Set<string>>();
const addIdentity=(identity:string,id:string)=>{if(!byIdentity.has(identity))byIdentity.set(identity,new Set());byIdentity.get(identity)!.add(id);byRepoId.set(id,identity);};
for(const r of conductor.repos){
 const id=repoId(r.id);const git=resolveRepository(r.root_path);const remote=canonicalizeRemote(r.remote_url)||git.remote;
 const identity=remote?`remote:${remote}`:git.identity;addIdentity(identity,id);if(git.confidence==='filesystem'&&git.identity!==identity)addIdentity(git.identity,id);
 repoRoots.set(id,new Set([r.root_path,git.root].filter((p):p is string=>!!p).map(canonical)));
}
const sessionCandidates=new Map<string,any[]>();
for(const r of records) {
 const keys=[hash(`${r.provider}:${r.id}`)];
 const dbRows=conductor.sessions.filter((s:any)=>s.claude_session_id===r.id&&((r.provider==='codex'&&s.agent_type==='codex')||(r.provider==='cursor'&&s.agent_type==='cursor')||(r.provider==='claude'&&['claude','claude-code','claude_code'].includes(s.agent_type))));
 for(const s of dbRows)keys.push(hash(s.id));
 r.dbRows=dbRows;
 for(const key of keys){if(!sessionCandidates.has(key))sessionCandidates.set(key,[]);sessionCandidates.get(key)!.push(r);}
}
const rows:any[]=[];
const missing:any[]=[];
const repoLabels=new Map(snapshot.repositories.map((r:any)=>[r.repository.id,r.repository.name]));
const bucket=(id:string)=>{const name=String(repoLabels.get(id)??'');return name==='Ephemeral automation sessions'?'ephemeral':name.endsWith('(local directory)')?'local-directory':'repository';};
const workspaces=conductor.workspaces;
for(const s of snapshot.sessions){
 let rs=sessionCandidates.get(s.sessionKey)??[];
 const db=conductor.sessions.filter((d:any)=>hash(d.id)===s.sessionKey||(d.claude_session_id&&hash(`${s.provider}:${d.claude_session_id}`)===s.sessionKey)||hash(`${s.provider}:row:${d.id}`)===s.sessionKey);
 if(!rs.length&&db.length){rs=db.map((d:any)=>({provider:s.provider,id:d.claude_session_id??d.id,source:'conductor-only',cwds:[],metadataRemotes:[],dbRows:[d],firstAt:d.created_at,lastAt:d.updated_at}));}
 if(!rs.length){missing.push({sessionKey:s.sessionKey,provider:s.provider,repositoryId:s.repositoryId,costUsd:s.cost.totalUsd,tokens:s.tokens.inputTokens+s.tokens.outputTokens});continue;}
 const r=rs.find((x:any)=>x.source!=='transcript')??rs[0];
 const cwds=[...new Set([r.cwd,...(r.cwds??[])].filter(Boolean))] as string[];
 const remote='initialMetadataRemote' in r?r.initialMetadataRemote:r.metadataRemotes?.[0];
 const git=resolveRepository(r.cwd,remote);
 let identity=git.identity;let candidates=new Set<string>();let route='unresolved';
 const matchedWorkspaces=workspaces.filter((w:any)=>(w.candidatePaths??[w.workspace_path]).filter(Boolean).some((p:string)=>!!r.cwd&&within(canonical(r.cwd),canonical(p))));
 matchedWorkspaces.sort((a:any,b:any)=>Math.max(...(b.candidatePaths??[b.workspace_path]).filter(Boolean).map((p:string)=>p.length),0)-Math.max(...(a.candidatePaths??[a.workspace_path]).filter(Boolean).map((p:string)=>p.length),0));
 const dbRepoIds=new Set<string>();for(const d of r.dbRows??[]){const w=conductor.workspacesById.get(d.workspace_id);if(w)dbRepoIds.add(repoId(w.repository_id));}
 const directRootIds=[...repoRoots.entries()].filter(([,roots])=>[...roots].some(root=>r.cwd&&within(canonical(r.cwd),root))).map(([id])=>id);
 if(git.confidence!=='unresolved'){
  candidates=new Set(byIdentity.get(identity)??[]);route=git.confidence==='metadata'?'metadata-remote':'git';
  if(!candidates.size&&git.root){
    const root=git.commonDir?.endsWith('/.git')?dirname(git.commonDir):git.root;
    const id=discoveredId(git.remote?`remote:${git.remote}`:canonical(root));candidates.add(id);addIdentity(identity,id);
  }
  if(!candidates.size&&git.confidence==='metadata'){route='metadata-unregistered';if(git.remote){const id=discoveredId(`remote:${git.remote}`);candidates.add(id);addIdentity(identity,id);}}
 } else if(matchedWorkspaces.length){
  const w=matchedWorkspaces[0]!;candidates.add(repoId(w.repository_id));identity=byRepoId.get(repoId(w.repository_id))!;route='workspace';
 } else if(dbRepoIds.size===1){candidates=dbRepoIds;identity=byRepoId.get([...candidates][0]!)!;route='registered-session';}
 else if(directRootIds.length){candidates=new Set(directRootIds);identity=byRepoId.get(directRootIds[0]!)!;route='registered-root';}
 else if(r.source==='conductor-only'&&r.dbRows?.length){identity='unassigned:conductor';const id=repoId(identity);candidates.add(id);addIdentity(identity,id);route='registered-unassigned';}
 else if(r.cwd){const local=localDirectoryAttribution(r.cwd,git);candidates.add(discoveredId(local.root));route=local.route;}
 const actualIdentity=byRepoId.get(s.repositoryId);
 const active=priorRows.has(s.sessionKey)?priorRows.get(s.sessionKey).active:(r.lastAt&&Date.parse(r.lastAt)>Date.parse(cutoff))||(s.lastEventAt&&Date.parse(s.lastEventAt)>Date.parse(cutoff));
 const allIdentities=new Set(cwds.map(c=>resolveRepository(c,remote).identity));
 const commonRoot=git.commonDir?.endsWith('/.git')?dirname(git.commonDir):git.root;
 const physicalRegisteredRoots=commonRoot?[...repoRoots].filter(([,roots])=>roots.has(canonical(commonRoot))).map(([id])=>id):[];
 const row={sessionKey:s.sessionKey,provider:s.provider,source:r.source,actualRepositoryId:s.repositoryId,expectedRepositoryIds:[...candidates].sort(),identityHash:hash(identity??'unknown'),actualIdentityHash:actualIdentity?hash(actualIdentity):null,route,bucket:bucket(s.repositoryId),matches:candidates.has(s.repositoryId),active:!!active,costUsd:s.cost.totalUsd,tokens:s.tokens.inputTokens+s.tokens.outputTokens,inputTokens:s.tokens.inputTokens,outputTokens:s.tokens.outputTokens,month:(s.firstEventAt??s.createdAt??'unknown').slice(0,7),models:s.models.map((m:any)=>({model:m.model,costUsd:m.totalUsd,inputTokens:m.inputTokens,outputTokens:m.outputTokens})),sourceFileCount:r.files?.length??0,primaryFileCount:(r.files?.length??0)-(r.childFiles??0),cwdHash:r.cwd?hash(r.cwd):null,cwdIsSymlink:!!r.cwd&&canonical(r.cwd)!==resolve(r.cwd),gitRootHash:git.root?hash(git.root):null,commonRootHash:commonRoot?hash(commonRoot):null,physicalRegisteredRoots,cwdCount:priorRows.get(s.sessionKey)?.cwdCount??cwds.length,repositoryIdentityCount:priorRows.get(s.sessionKey)?.repositoryIdentityCount??allIdentities.size,metadataRemoteCount:r.metadataRemotes?.length??0,metadataDisagrees:git.metadataDisagrees,gitEvidence:git.evidence,directoryExists:git.directoryExists,matchedWorkspaceCount:matchedWorkspaces.length,registeredSessionCount:r.dbRows?.length??0,registeredRepositoryIds:[...dbRepoIds],metadataIds:priorRows.get(s.sessionKey)?.metadataIds??r.metadataIds?.length??0};
 rows.push(row);
}
const totals=(items:any[])=>({sessions:items.length,costUsd:items.reduce((n,r)=>n+r.costUsd,0),inputTokens:items.reduce((n,r)=>n+r.inputTokens,0),outputTokens:items.reduce((n,r)=>n+r.outputTokens,0),tokens:items.reduce((n,r)=>n+r.tokens,0)});
const group=(items:any[],key:string)=>Object.fromEntries([...new Set(items.map(x=>x[key]))].sort().map(k=>[k,totals(items.filter(x=>x[key]===k))]));
const eligible=rows.filter(r=>!r.active);const mismatch=eligible.filter(r=>!r.matches);
const identities=new Map<string,any[]>();for(const r of eligible){if(!identities.has(r.identityHash))identities.set(r.identityHash,[]);identities.get(r.identityHash)!.push(r);}
const splits=[...identities.entries()].filter(([,r])=>new Set(r.map(x=>x.actualRepositoryId)).size>1).map(([identityHash,r])=>({identityHash,repositoryIds:[...new Set(r.map(x=>x.actualRepositoryId))],...totals(r),byRepository:group(r,'actualRepositoryId')}));
const result={generatedAt:new Date().toISOString(),referenceGeneratedAt:cutoff,nativeCounts:prior?.nativeCounts??native.counts,headerRecheckCounts:prior?native.counts:undefined,cursorCount:cursor.length,conductorCounts:{repos:conductor.repos.length,workspaces:workspaces.length,sessions:conductor.sessions.length},coverage:{reference:snapshot.sessions.length,matched:rows.length,missing:missing.length,activeExcluded:rows.filter(r=>r.active).length},eligible:totals(eligible),mismatches:totals(mismatch),byProvider:group(mismatch,'provider'),byMonth:group(mismatch,'month'),byRoute:group(mismatch,'route'),byBucket:group(eligible,'bucket'),splits,missing,rows};
writeFileSync('.lane/repos-oracle.json',JSON.stringify(result,null,2)+'\n');
process.stdout.write(JSON.stringify({coverage:result.coverage,eligible:result.eligible,mismatches:result.mismatches,byRoute:result.byRoute,splits:result.splits.map(s=>({identityHash:s.identityHash,rows:s.repositoryIds.length,sessions:s.sessions,costUsd:s.costUsd}))},null,2)+'\n');

}
main().catch(()=>{process.stderr.write('Repository attribution oracle failed; private details withheld.\n');process.exitCode=1;});
