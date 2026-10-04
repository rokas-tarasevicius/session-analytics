/** Independent raw metadata reader. Intentionally does not import production code.
 * Private paths/IDs remain in memory. Callers must serialize only explicit hashes/counters. */
import { readdirSync, realpathSync, existsSync, createReadStream } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';

export interface NativeRecord {
  provider: 'claude' | 'codex'; id: string; source: string; files: string[];
  cwd?: string; cwds: string[]; metadataRemotes: string[]; initialMetadataRemote: string | null;
  firstAt?: string; lastAt?: string; metadataCount: number; childFiles: number;
  metadataIds: string[]; lineCount: number; malformedLines: number;
  cwdObservations: {cwd: string; timestamp?: string; count: number}[];
}
function canonical(path: string): string { try { return realpathSync(path); } catch { return resolve(path); } }
function dirs(root: string): string[] { try { return readdirSync(root, {withFileTypes:true}).filter(x=>x.isDirectory()||x.isSymbolicLink()).map(x=>join(root,x.name)); } catch {return [];} }
function files(root: string): string[] {
  const out: string[]=[];
  const walk=(path:string)=>{ let entries; try { entries=readdirSync(path,{withFileTypes:true}); }catch{return;}
    for(const e of entries) {const p=join(path,e.name); if(e.isDirectory())walk(p); else if(e.isFile()&&e.name.endsWith('.jsonl'))out.push(p);}
  };walk(root);return out.sort();
}
function iso(value: unknown): string|undefined {if(typeof value!=='string')return;const t=Date.parse(value);return Number.isFinite(t)?new Date(t).toISOString():undefined;}
export async function loadNative(home: string): Promise<{records:NativeRecord[];counts:Record<string,number>}> {
  const homes=dirs(home); const roots:{provider:'claude'|'codex'; path:string}[]=[];const seenRoots=new Set<string>();
  const add=(provider:'claude'|'codex',path:string)=>{if(!existsSync(path))return;path=canonical(path);if(!seenRoots.has(path)){seenRoots.add(path);roots.push({provider,path});}};
  for(const h of homes){const n=basename(h); if(n==='.claude'||n.startsWith('.claude-'))add('claude',join(h,'projects'));
    if(n==='.codex'||n.startsWith('.codex-'))for(const d of ['sessions','archived_sessions'])add('codex',join(h,d));}
  add('claude',join(home,'.config/claude/projects'));
  if(process.env.CLAUDE_CONFIG_DIR)add('claude',join(process.env.CLAUDE_CONFIG_DIR,'projects'));
  if(process.env.CODEX_HOME)for(const d of ['sessions','archived_sessions'])add('codex',join(process.env.CODEX_HOME,d));
  add('claude',join(home,'Library/Application Support/Claude/local-agent-mode-sessions'));
  const grouped=new Map<string,NativeRecord>();const seenFiles=new Set<string>();let count=0;
  for(const root of roots)for(const path of files(root.path)) {
    const resolved=canonical(path); if(seenFiles.has(resolved))continue;seenFiles.add(resolved);count++;
    const child=path.includes('/subagents/');
    let id=child?basename(path.split('/subagents/')[0]!):basename(path,'.jsonl');
    let record:NativeRecord={provider:root.provider,id,source:root.provider==='codex'?'rollout':child?'claude-child':'claude-primary',files:[path],cwds:[],metadataRemotes:[],initialMetadataRemote:null,metadataCount:0,childFiles:child?1:0,metadataIds:[],lineCount:0,malformedLines:0,cwdObservations:[]};
    const observations=new Map<string,{cwd:string;timestamp?:string;count:number}>();
    const input=createReadStream(path); const lines=createInterface({input,crlfDelay:Infinity});
    try {for await(const line of lines) {
      if(!line.trim())continue;record.lineCount++;let r:any;try{r=JSON.parse(line);}catch{record.malformedLines++;continue;}
      if(!r||typeof r!=='object')continue;
      const timestamp=iso(r.timestamp); if(timestamp){if(!record.firstAt||timestamp<record.firstAt)record.firstAt=timestamp;if(!record.lastAt||timestamp>record.lastAt)record.lastAt=timestamp;}
      let cwd=root.provider==='claude'?r.cwd:undefined;
      if(root.provider==='claude'&&!child&&typeof r.sessionId==='string'&&!record.metadataIds.length){id=r.sessionId;record.metadataIds.push(id);}
      if(root.provider==='codex'&&r.type==='session_meta') {
        const p=r.payload??{}; if(typeof p.id==='string'){if(record.metadataCount===0)id=p.id;record.metadataIds.push(p.id);}
        if(typeof p.cwd==='string')cwd=p.cwd;
        if(record.metadataCount===0)record.initialMetadataRemote=typeof p.git?.repository_url==='string'?p.git.repository_url:null;
        if(typeof p.git?.repository_url==='string')record.metadataRemotes.push(p.git.repository_url);
        record.metadataCount++;
      }
      // turn_context may carry cwd changes after a resumed/moved execution.
      if(root.provider==='codex'&&r.type==='turn_context'&&typeof r.payload?.cwd==='string')cwd=r.payload.cwd;
      if(typeof cwd==='string'&&cwd.startsWith('/')) {
        if(!record.cwd)record.cwd=cwd;
        const o=observations.get(cwd);if(o)o.count++;else observations.set(cwd,{cwd,timestamp,count:1});
      }
    }} catch {record.malformedLines++;} finally {lines.close();input.destroy();}
    record.id=id;record.cwds=[...observations.keys()];record.cwdObservations=[...observations.values()];record.metadataIds=[...new Set(record.metadataIds)];record.metadataRemotes=[...new Set(record.metadataRemotes)];
    const key=`${root.provider}:${id}`;const previous=grouped.get(key);
    if(!previous)grouped.set(key,record);else {
      previous.files.push(path);previous.childFiles+=record.childFiles;previous.metadataCount+=record.metadataCount;previous.lineCount+=record.lineCount;previous.malformedLines+=record.malformedLines;
      if(record.firstAt&&(!previous.firstAt||record.firstAt<previous.firstAt))previous.firstAt=record.firstAt;
      if(record.lastAt&&(!previous.lastAt||record.lastAt>previous.lastAt))previous.lastAt=record.lastAt;
      // Parent evidence controls identity/CWD, child paths are retained only as attribution diagnostics.
      if(!child&&record.cwd){previous.cwd=record.cwd;previous.source=record.source;previous.initialMetadataRemote=record.initialMetadataRemote;}
      previous.cwds=[...new Set([...previous.cwds,...record.cwds])];
      previous.metadataIds=[...new Set([...previous.metadataIds,...record.metadataIds])];
      previous.metadataRemotes=[...new Set([...previous.metadataRemotes,...record.metadataRemotes])];
      previous.cwdObservations.push(...record.cwdObservations);
    }
  }
  return {records:[...grouped.values()],counts:{roots:roots.length,files:count,sessions:grouped.size,lines:[...grouped.values()].reduce((s,r)=>s+r.lineCount,0)}};
}
