/** PRIVATE in-memory paths for an independent repository inventory census.
 * Never serialize this return value. Multiple physical clones stay explicit so
 * callers cannot turn an ambiguous logical remote into an invented single root. */
import { createHash } from 'node:crypto';
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { loadConductor } from './conductor-oracle.ts';
import { loadNativeHeads } from './native-heads.ts';
import { loadCursor } from './cursor-oracle.ts';
import { resolveRepository } from './git-oracle.ts';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex').slice(0,20);
const canonical=(path:string)=>{try{return realpathSync(path);}catch{return resolve(path);}};
export function inventoryRootCandidates(registered: Array<{id:string;root_path:string}>, records: Array<{cwd?:string|null;initialMetadataRemote?:string|null;metadataRemotes?:string[]}>, selected?:ReadonlySet<string>):Map<string,string[]>{
  const candidates=new Map<string,Set<string>>();
  const add=(id:string,path:string|null)=>{if(selected&&!selected.has(id))return;let roots=candidates.get(id);if(!roots){roots=new Set();candidates.set(id,roots);}if(path&&isAbsolute(path))roots.add(canonical(path));};
  for(const row of registered)add(`conductor-${hash(`conductor:${row.id}`)}`,canonical(row.root_path));
  // The analyzer attempts the literal sentinel as a relative lookup. Its
  // missing ownership is not proof that no inventory is read there.
  add(`conductor-${hash('conductor:unassigned:conductor')}`,resolve('unassigned:conductor'));
  const seen=new Set<string>();
  for(const record of records){
    if(!record.cwd||!isAbsolute(record.cwd))continue;
    const cwd=canonical(record.cwd),remote='initialMetadataRemote' in record?record.initialMetadataRemote:record.metadataRemotes?.[0],signature=JSON.stringify([cwd,remote]);
    if(seen.has(signature))continue;seen.add(signature);
    const git=resolveRepository(cwd,remote??undefined);
    const physical=git.commonDir?.endsWith('/.git')?dirname(git.commonDir):git.root;
    const ephemeral=!physical&&!git.remote&&cwd.startsWith('/private/var/folders/')&&cwd.includes('/T/');
    const grouping=git.remote?`remote:${git.remote}`:ephemeral?'/private/var/folders/session-analytics-ephemeral':physical??cwd;
    add(`discovered-${hash(grouping)}`,ephemeral?grouping:physical??cwd);
  }
  return new Map([...candidates].map(([id,roots])=>[id,[...roots].sort()]));
}
export async function loadInventoryRootCandidates(selected?:ReadonlySet<string>,home=homedir()):Promise<Map<string,string[]>>{
  const conductor=loadConductor(home),native=await loadNativeHeads(home),cursor=loadCursor(home);
  return inventoryRootCandidates(conductor.repos,[...native.records,...cursor],selected);
}

export interface InventoryRoot { path: string; provider: 'claude'|'codex'; repositoryId: string|null }
export interface InventoryRootCoverage { repositoryId: string; candidates: number; status: 'resolved'|'missing'|'ambiguous' }
export interface InventoryRootAlternatives { repositoryId:string; candidates:InventoryRoot[][] }
const skillDirectories=(path:string,repositoryId:string):InventoryRoot[]=>[['.claude','claude'],['.codex','codex'],['.agents','codex']].map(([directory,provider])=>({path:join(path,directory!,'skills'),provider:provider as 'claude'|'codex',repositoryId}));
/** roots and alternatives are private. Coverage and fixed failures may be persisted. */
export function inventorySkillRoots(candidates: ReadonlyMap<string,readonly string[]>, selected:ReadonlySet<string>, globalRoots:readonly InventoryRoot[]):{
  roots:InventoryRoot[]; alternatives:InventoryRootAlternatives[]; coverage:InventoryRootCoverage[]; failures:string[];
}{
  const roots=[...globalRoots],alternatives:InventoryRootAlternatives[]=[],coverage:InventoryRootCoverage[]=[],failures:string[]=[];
  for(const repositoryId of [...selected].sort()){
    const choices=candidates.get(repositoryId);
    const status=!choices?.length?'missing':choices.length===1?'resolved':'ambiguous';
    coverage.push({repositoryId,candidates:choices?.length??0,status});
    if(status==='missing'||status==='ambiguous'){
      failures.push(`repository:${repositoryId}:${status}`);
      if(status==='ambiguous')alternatives.push({repositoryId,candidates:choices!.map(path=>skillDirectories(path,repositoryId))});
      continue;
    }
    if(choices?.length===1)roots.push(...skillDirectories(choices[0]!,repositoryId));
  }
  return{roots,alternatives,coverage,failures};
}

/** Independent default profile census. ENOENT is the only absence proof. */
export function globalInventoryRoots(home=homedir(),environment:NodeJS.ProcessEnv=process.env):InventoryRoot[]{
  const directory=(path:string):boolean=>{try{return statSync(path).isDirectory();}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw new Error('Inventory profile evidence could not be read.');}};
  let entries:string[];
  try{entries=readdirSync(home);}catch{throw new Error('Inventory home profile evidence could not be read.');}
  const claude=new Set([join(home,'.claude')]),codex=new Set([join(home,'.codex')]);
  const claudeCandidates=[...entries.filter(name=>name==='.claude'||name.startsWith('.claude-')).map(name=>join(home,name)),join(home,'.config','claude'),...(environment.CLAUDE_CONFIG_DIR?[environment.CLAUDE_CONFIG_DIR]:[])];
  const codexCandidates=[...entries.filter(name=>name==='.codex'||name.startsWith('.codex-')).map(name=>join(home,name)),...(environment.CODEX_HOME?[environment.CODEX_HOME]:[])];
  for(const path of claudeCandidates)if(directory(join(path,'projects')))claude.add(canonical(path));
  for(const path of codexCandidates)if(directory(join(path,'sessions'))||directory(join(path,'archived_sessions')))codex.add(canonical(path));
  return[...[...claude].map(path=>({path:join(path,'skills'),provider:'claude' as const,repositoryId:null})),...[...codex].map(path=>({path:join(path,'skills'),provider:'codex' as const,repositoryId:null})),{path:join(home,'.agents','skills'),provider:'codex',repositoryId:null}];
}

export async function loadInventorySkillRoots(selected?:ReadonlySet<string>,home=homedir(),environment:NodeJS.ProcessEnv=process.env){
  const candidates=await loadInventoryRootCandidates(selected,home);
  return inventorySkillRoots(candidates,selected??new Set(candidates.keys()),globalInventoryRoots(home,environment));
}
