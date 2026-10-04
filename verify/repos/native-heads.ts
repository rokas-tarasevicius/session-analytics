/** Fast independent raw native identity/CWD census. Returns PRIVATE metadata only.
 * fullSessionKeys contains sha256(provider + ':' + id)[0:12] keys whose files
 * need a complete timestamp/CWD pass; other files stop at initial identity+cwd. */
import { readdirSync, realpathSync, existsSync, createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { NativeRecord } from './native-oracle.ts';

export interface NativeHeadRecord extends NativeRecord {
  /** Desktop metadata aliases; never print or persist these. */
  identityAliases: string[];
  completeTimestampPass: boolean;
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0,12);
const canonical = (p: string): string => { try { return realpathSync(p); } catch { return resolve(p); } };
const entries = (p: string) => { try { return readdirSync(p, {withFileTypes:true}); } catch { return []; } };
const iso = (v: unknown): string | undefined => {
  if (typeof v !== 'string' && typeof v !== 'number') return undefined;
  const t = new Date(v); return Number.isFinite(t.getTime()) ? t.toISOString() : undefined;
};
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
function listing(root: string, accept: (p: string) => boolean, depthLimit = 40): string[] {
  const files: string[] = [];
  function walk(dir: string, depth: number): void {
    if (depth > depthLimit) return;
    for (const e of entries(dir)) {
      const p = join(dir,e.name);
      if (e.isDirectory()) walk(p, depth+1);
      else if (e.isFile() && accept(p)) files.push(p);
    }
  }
  walk(root,0); return files.sort();
}
export async function loadNativeHeads(home: string, fullSessionKeys: Set<string> = new Set()): Promise<{ records: NativeHeadRecord[]; counts: Record<string,number> }> {
  const roots: {provider:'claude'|'codex';path:string;desktop?:boolean}[] = []; const rootKeys = new Set<string>();
  function add(provider:'claude'|'codex',p:string,desktop=false):void {
    if (!existsSync(p)) return; p=canonical(p); const key=provider+':'+p;
    if(rootKeys.has(key))return;rootKeys.add(key);roots.push({provider,path:p,desktop});
  }
  for (const e of entries(home)) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (e.name === '.claude' || e.name.startsWith('.claude-')) add('claude',join(home,e.name,'projects'));
    if (e.name === '.codex' || e.name.startsWith('.codex-')) for(const d of ['sessions','archived_sessions'])add('codex',join(home,e.name,d));
  }
  add('claude',join(home,'.config/claude/projects'));
  if(process.env.CLAUDE_CONFIG_DIR)add('claude',join(process.env.CLAUDE_CONFIG_DIR,'projects'));
  if(process.env.CODEX_HOME)for(const d of ['sessions','archived_sessions'])add('codex',join(process.env.CODEX_HOME,d));
  const desktopRoot=join(home,'Library/Application Support/Claude/local-agent-mode-sessions');
  add('claude',desktopRoot,true);
  const desktop = new Map<string,{cwd?:string;aliases:string[];firstAt?:string;lastAt?:string}>();
  for(const p of listing(desktopRoot,p=>p.endsWith('.json'),3)) {
    let r:any;try{r=JSON.parse(readFileSync(p,'utf8'));}catch{continue;}
    if(typeof r?.cliSessionId!=='string'||typeof r?.sessionId!=='string')continue;
    desktop.set(r.cliSessionId,{cwd:typeof r.cwd==='string'&&r.cwd.startsWith('/')?r.cwd:undefined,aliases:[r.sessionId],firstAt:iso(r.createdAt),lastAt:iso(r.lastActivityAt)});
  }
  const grouped = new Map<string,NativeHeadRecord>(); const seenFiles = new Set<string>();
  const counts={roots:roots.length,files:0,sessions:0,lines:0,fullFiles:0,headerOnlyFiles:0,metadataRows:desktop.size,skippedDesktopNonSessionFiles:0,limitedFiles:0};
  for(const root of roots)for(const p of listing(root.path,p=>p.endsWith('.jsonl'))) {
    if(root.desktop&&!uuid.test(basename(p,'.jsonl'))){counts.skippedDesktopNonSessionFiles++;continue;}
    const file=canonical(p);if(seenFiles.has(file))continue;seenFiles.add(file);counts.files++;
    const child=p.includes('/subagents/');
    const fileStem=basename(p,'.jsonl');const filenameId=root.provider==='codex'?/([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/i.exec(fileStem)?.[1]||fileStem:child?basename(p.split('/subagents/')[0]!):fileStem;
    let id=filenameId;let establishedId=false;let full=fullSessionKeys.has(hash(`${root.provider}:${id}`));let terminatedEarly=false;let bytes=0;
    const record:NativeHeadRecord={provider:root.provider,id,source:root.desktop?'claude-desktop':root.provider==='codex'?'rollout':child?'claude-child':'claude-primary',files:[p],cwds:[],metadataRemotes:[],initialMetadataRemote:null,metadataCount:0,childFiles:child?1:0,metadataIds:[],lineCount:0,malformedLines:0,cwdObservations:[],identityAliases:[],completeTimestampPass:false};
    const observations=new Map<string,{cwd:string;timestamp?:string;count:number}>();
    const input=createReadStream(p);const lines=createInterface({input,crlfDelay:Infinity});
    try {
      for await(const line of lines) {
        if(!line.trim())continue;record.lineCount++;bytes+=Buffer.byteLength(line);let r:any;
        try{r=JSON.parse(line);}catch{record.malformedLines++;if(!full&&(record.lineCount>=256||bytes>8*1024*1024)){terminatedEarly=true;counts.limitedFiles++;break;}continue;}
        if(!r||typeof r!=='object')continue;
        const at=iso(r.timestamp);if(at){if(!record.firstAt||at<record.firstAt)record.firstAt=at;if(!record.lastAt||at>record.lastAt)record.lastAt=at;}
        let cwd=root.provider==='claude'?r.cwd:undefined;
        if(root.provider==='codex'&&r.type==='session_meta') {
          const meta=r.payload??{};
          if(typeof meta.id==='string') {
            record.metadataIds.push(meta.id);
            if(!establishedId){id=meta.id;establishedId=true;full ||= fullSessionKeys.has(hash(`${root.provider}:${id}`));}
          }
          if(typeof meta.cwd==='string')cwd=meta.cwd;
          if(record.metadataCount===0)record.initialMetadataRemote=typeof meta.git?.repository_url==='string'?meta.git.repository_url:null;
          if(typeof meta.git?.repository_url==='string')record.metadataRemotes.push(meta.git.repository_url);
          record.metadataCount++;
        }
        if(root.provider==='codex'&&r.type==='turn_context'&&typeof r.payload?.cwd==='string')cwd=r.payload.cwd;
        if(typeof cwd==='string'&&cwd.startsWith('/')) {
          if(!record.cwd)record.cwd=cwd;
          const old=observations.get(cwd);if(old)old.count++;else observations.set(cwd,{cwd,timestamp:at,count:1});
        }
        if(!full&&record.cwd&&(root.provider==='claude'||establishedId)){terminatedEarly=true;break;}
        if(!full&&(record.lineCount>=256||bytes>8*1024*1024)){terminatedEarly=true;counts.limitedFiles++;break;}
      }
    }catch{record.malformedLines++;terminatedEarly=true;}finally{lines.close();input.destroy();}
    record.id=id;record.cwds=[...observations.keys()];record.cwdObservations=[...observations.values()];record.metadataIds=[...new Set(record.metadataIds)];record.metadataRemotes=[...new Set(record.metadataRemotes)];record.completeTimestampPass=!terminatedEarly;
    if(full)counts.fullFiles++;else counts.headerOnlyFiles++;counts.lines+=record.lineCount;
    const meta=desktop.get(id);
    if(meta){record.identityAliases=meta.aliases;record.source='claude-desktop';if(!record.cwd&&meta.cwd){record.cwd=meta.cwd;record.cwds.push(meta.cwd);record.cwdObservations.push({cwd:meta.cwd,timestamp:meta.firstAt,count:1});}if(meta.firstAt&&(!record.firstAt||meta.firstAt<record.firstAt))record.firstAt=meta.firstAt;if(meta.lastAt&&(!record.lastAt||meta.lastAt>record.lastAt))record.lastAt=meta.lastAt;}
    const key=`${root.provider}:${id}`;const prev=grouped.get(key);
    if(!prev)grouped.set(key,record);else {
      prev.files.push(p);prev.childFiles+=record.childFiles;prev.metadataCount+=record.metadataCount;prev.lineCount+=record.lineCount;prev.malformedLines+=record.malformedLines;
      if(record.firstAt&&(!prev.firstAt||record.firstAt<prev.firstAt))prev.firstAt=record.firstAt;
      if(record.lastAt&&(!prev.lastAt||record.lastAt>prev.lastAt))prev.lastAt=record.lastAt;
      if(!child&&record.cwd){prev.cwd=record.cwd;prev.source=record.source;prev.initialMetadataRemote=record.initialMetadataRemote;}
      prev.cwds=[...new Set([...prev.cwds,...record.cwds])];prev.metadataIds=[...new Set([...prev.metadataIds,...record.metadataIds])];prev.metadataRemotes=[...new Set([...prev.metadataRemotes,...record.metadataRemotes])];prev.cwdObservations.push(...record.cwdObservations);prev.identityAliases=[...new Set([...prev.identityAliases,...record.identityAliases])];prev.completeTimestampPass&&=record.completeTimestampPass;
    }
  }
  counts.sessions=grouped.size;return {records:[...grouped.values()],counts};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const fullKeys=new Set<string>();
  if(process.argv[2]){const prior=JSON.parse(readFileSync(process.argv[2],'utf8'));for(const r of prior.missing??[])if(r.provider==='codex')fullKeys.add(r.sessionKey);}
  try{const result=await loadNativeHeads(homedir(),fullKeys);writeFileSync('.lane/native-heads-evidence.json',JSON.stringify({counts:result.counts,records:result.records.map(r=>({sessionKey:hash(`${r.provider}:${r.id}`),provider:r.provider,source:r.source,cwdHash:r.cwd?hash(r.cwd):null,cwdCount:r.cwds.length,firstAt:r.firstAt,lastAt:r.lastAt,files:r.files.length,metadataIds:r.metadataIds.length,completeTimestampPass:r.completeTimestampPass}))},null,2)+'\n');console.log(JSON.stringify(result.counts));}catch{console.error('Native heads census failed; raw local details withheld.');process.exitCode=1;}
}
