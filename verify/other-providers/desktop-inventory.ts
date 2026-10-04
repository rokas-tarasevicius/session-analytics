/** Bounded, read-only survey. Output contains allowlisted vendor/store enums and counts only. */
import { readdir, readFile, stat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, extname, basename } from 'node:path';
import { DatabaseSync } from '../shared/sqlite.ts';

async function main(): Promise<void> {
const home=homedir();
const skip=new Set(['node_modules','.git','Cache','Code Cache','GPUCache','DawnGraphiteCache','DawnWebGPUCache','blob_storage','extensions','plugins','skills','logs','workspaces','repos','repositories','snapshots','artifacts','scratch','checkpoints']);
async function walk(root:string,depth=0):Promise<string[]> {
 if(depth>7)return [];
 let entries;try{entries=await readdir(root,{withFileTypes:true});}catch{return [];}
 const out=[];
 for(const e of entries){if(e.isSymbolicLink()||skip.has(e.name))continue;const p=join(root,e.name);if(e.isDirectory()){for(const child of await walk(p,depth+1))out.push(child);}else if(e.isFile())out.push(p);}
 return out;
}
async function exists(p:string){try{return (await stat(p)).isDirectory();}catch{return false;}}
function protoWire(bytes:Buffer){
 let p=0;
 function varint(){let value=0n,bits=0n;for(let i=0;i<10&&p<bytes.length;i++){const b=bytes[p++]!;value|=BigInt(b&127)<<bits;if(!(b&128))return value;bits+=7n;}throw Error('invalid');}
 try {while(p<bytes.length){const tag=varint();const field=tag>>3n,wire=Number(tag&7n);if(!field||field>536870911n)return false;if(wire===0)varint();else if(wire===1)p+=8;else if(wire===2){const n=varint();if(n>BigInt(bytes.length))return false;p+=Number(n);}else if(wire===5)p+=4;else return false;if(p>bytes.length)return false;}return true;}catch{return false;}
}
const opaque=[];
for(const [provider,parts] of [['windsurf',['.codeium','windsurf','cascade']],['antigravity',['.gemini','antigravity','conversations']]] as const){
 const root=join(home,...parts);const fs=(await walk(root)).filter(p=>extname(p)==='.pb');let totalBytes=0,validWire=0;const months=new Set<string>();
 for(const p of fs){const st=await stat(p);totalBytes+=st.size;months.add(st.mtime.toISOString().slice(0,7));if(protoWire(await readFile(p)))validWire++;}
 opaque.push({provider,storePresent:await exists(root),conversationFiles:fs.length,totalBytes,validBareProtobufFiles:validWire,fileMtimeMonths:[...months].sort(),estimatedTokens:null,estimatedCostUsd:null});
}
const t3=[];
for(const p of (await walk(join(home,'.t3'))).filter(p=>extname(p)==='.sqlite')){
 let db;try{db=new DatabaseSync(p,{readOnly:true});const tables=[];for(const table of ['orchestration_events','projection_threads','projection_thread_messages','projection_thread_sessions','provider_session_runtime']){const present=db.prepare('SELECT 1 FROM sqlite_master WHERE type=? AND name=?').get('table',table);if(present)tables.push({table,rows:db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get()!.n});}t3.push({tables});}catch{t3.push({unreadable:true});}finally{db?.close();}
}
const standardRoots:string[]=[];
const profileCounts={claude:0,codex:0};
for(const e of await readdir(home,{withFileTypes:true})){for(const provider of ['claude','codex'] as const){if(e.name===`.${provider}`||e.name.startsWith(`.${provider}-`)){if(!e.isDirectory()&&!e.isSymbolicLink())continue;profileCounts[provider]++;for(const store of provider==='claude'?['projects']:['sessions','archived_sessions'])if(await exists(join(home,e.name,store)))standardRoots.push(await realpath(join(home,e.name,store)));}}}
for(const p of [join(home,'.config/claude/projects'),process.env.CLAUDE_CONFIG_DIR&&join(process.env.CLAUDE_CONFIG_DIR,'projects'),process.env.CODEX_HOME&&join(process.env.CODEX_HOME,'sessions'),process.env.CODEX_HOME&&join(process.env.CODEX_HOME,'archived_sessions')])if(p&&await exists(p))standardRoots.push(await realpath(p));
const appRoots=[['conductor',join(home,'Library/Application Support/com.conductor.app')],['conductor-home',join(home,'.conductor')],['t3',join(home,'.t3')],['claude-desktop',join(home,'Library/Application Support/Claude')],['codex-app',join(home,'Library/Application Support/Codex')],['devin',join(home,'.devin')],['devin-app',join(home,'Library/Application Support/Devin')]];
const appSurvey=[];
for(const [source,root] of appRoots){const fs=await walk(root!);let nativeRollouts=0,nativeClaude=0,nativeDuplicateRoots=0,exportFiles=0;const transcriptRoots=new Set<string>();
 for(const p of fs){const name=basename(p);if(/^rollout-.*\.jsonl$/.test(name)){nativeRollouts++;const i=p.lastIndexOf('/sessions/');if(i>=0)transcriptRoots.add(p.slice(0,i+9));}if(/^[a-f0-9]{8}-[a-f0-9-]{27}\.jsonl$/i.test(name))nativeClaude++;if(['conversations.json','chat_export.json','export.json'].includes(name))exportFiles++;}
 for(const r of transcriptRoots)if(standardRoots.includes(await realpath(r).catch(()=>r)))nativeDuplicateRoots++;
 appSurvey.push({source,present:await exists(root!),filesWithinBound:fs.length,nativeRolloutFiles:nativeRollouts,nativeClaudeShapedFiles:nativeClaude,discoveredRolloutRoots:transcriptRoots.size,nativeDuplicateRoots,possibleExportFiles:exportFiles});
}
console.log(JSON.stringify({oracleVersion:1,bounds:{maximumDepth:8,symlinksFollowed:false,excludedDirectoryClasses:[...skip]},opaque,t3,standardProfiles:profileCounts,canonicalStandardRoots:new Set(standardRoots).size,overrideEnvironment:{claudeConfigDirPresent:!!process.env.CLAUDE_CONFIG_DIR,codexHomePresent:!!process.env.CODEX_HOME},appSurvey},null,2));

}
main().catch(() => { process.stderr.write("Desktop validation could not read supported local evidence.\n"); process.exitCode = 1; });
