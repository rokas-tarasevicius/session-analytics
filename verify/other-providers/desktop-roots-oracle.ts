/** Read-only literal override inventory. Never executes configuration or emits values/paths. */
import { readdir,readFile,stat,realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join,isAbsolute } from 'node:path';

async function main(): Promise<void> {
const home=homedir();
const vars=['CLAUDE_CONFIG_DIR','CODEX_HOME'] as const;
const known=new Set<string>(),targets=new Map<string,{provider:string;origins:Set<string>}>();
async function exists(p:string){try{return(await stat(p)).isDirectory();}catch{return false;}}
async function canonical(p:string){return await realpath(p).catch(()=>p);}
function literal(raw:string){let value=raw.trim().replace(/^['"]|['"]$/g,'');value=value.replace(/^~(?=\/)/,home).replaceAll('${HOME}',home).replaceAll('$HOME',home);return /[$`\n\r]/.test(value)||!isAbsolute(value)?null:value;}
async function candidate(provider:string,value:string,origin:string){const p=literal(value);if(!p)return;const key=`${provider}:${await canonical(p)}`;const item=targets.get(key)??{provider,origins:new Set<string>()};item.origins.add(origin);targets.set(key,item);}
let broaderNames=0;const broader=[];
for(const e of await readdir(home,{withFileTypes:true})){
 if(!e.isDirectory()&&!e.isSymbolicLink())continue;
 for(const provider of ['claude','codex']){
  const standard=e.name===`.${provider}`||e.name.startsWith(`.${provider}-`);
  if(standard)known.add(`${provider}:${await canonical(join(home,e.name))}`);
  if(e.name.toLowerCase().includes(provider)){
   broaderNames++;let active=0,archive=0;
   const base=join(home,e.name),stores=provider==='claude'?['projects']:['sessions','archived_sessions'];
   for(const store of stores)if(await exists(join(base,store))){if(store==='archived_sessions')archive++;else active++;}
   if(active||archive){await candidate(provider,base,'broader-home-name');broader.push({provider,standard,activeStores:active,archiveStores:archive});}
  }
 }
}
known.add(`claude:${await canonical(join(home,'.config/claude'))}`);
let shellFilesRead=0,literalAssignments=0,unsupportedAssignments=0;
for(const name of ['.zshrc','.zprofile','.zshenv','.bashrc','.bash_profile','.profile','.config/fish/config.fish']){
 const p=join(home,name);let source;try{if((await stat(p)).size>512*1024)continue;source=await readFile(p,'utf8');shellFilesRead++;}catch{continue;}
 for(const line of source.split('\n')){
  if(line.trimStart().startsWith('#'))continue;
  const re=/(?:^|[\s;])(?:export\s+)?(CLAUDE_CONFIG_DIR|CODEX_HOME)\s*=\s*("[^"\n]*"|'[^'\n]*'|[^\s;#]+)/g;
  for(const m of line.matchAll(re)){if(literal(m[2]!)){literalAssignments++;await candidate(m[1]==='CODEX_HOME'?'codex':'claude',m[2]!,'shell-literal');}else unsupportedAssignments++;}
 }
}
let configFilesRead=0,jsonAssignments=0;
for(const p of [join(home,'.t3/userdata/settings.json'),join(home,'.conductor/settings.json'),join(home,'Library/Application Support/com.conductor.app/settings.json'),join(home,'Library/Application Support/com.conductor.app/config.json'),join(home,'Library/Application Support/Claude/claude_desktop_config.json')]){
 let json;try{if((await stat(p)).size>2*1024*1024)continue;json=JSON.parse(await readFile(p,'utf8'));configFilesRead++;}catch{continue;}
 async function scan(x:unknown,depth=0):Promise<void>{if(depth>8||!x||typeof x!=='object')return;for(const [k,v] of Object.entries(x)){if(vars.includes(k as typeof vars[number])&&typeof v==='string'){jsonAssignments++;await candidate(k==='CODEX_HOME'?'codex':'claude',v,'app-config-literal');}else await scan(v,depth+1);}}
 await scan(json);
}
for(const variable of vars)if(process.env[variable]){const p=literal(process.env[variable]!);if(p)known.add(`${variable==='CODEX_HOME'?'codex':'claude'}:${await canonical(p)}`);await candidate(variable==='CODEX_HOME'?'codex':'claude',process.env[variable]!,'current-environment');}
const results=[];
for(const [key,item] of targets){const base=key.slice(item.provider.length+1);let stores=0;for(const store of item.provider==='claude'?['projects']:['sessions','archived_sessions'])if(await exists(join(base,store)))stores++;results.push({provider:item.provider,origins:[...item.origins].sort(),withinDiscoveredProfiles:known.has(key),existingStores:stores});}
console.log(JSON.stringify({oracleVersion:1,bounds:{shellBytesPerFile:512*1024,appConfigBytesPerFile:2*1024*1024,configDepth:8,executedConfig:false},shellFilesRead,literalAssignments,unsupportedAssignments,configFilesRead,jsonAssignments,broaderMatchingDirectoryNames:broaderNames,broaderHistoryRoots:broader,targets:results,missedExistingRoots:results.filter(r=>!r.withinDiscoveredProfiles&&r.existingStores).length},null,2));

}
main().catch(() => { process.stderr.write("Desktop validation could not read supported local evidence.\n"); process.exitCode = 1; });
