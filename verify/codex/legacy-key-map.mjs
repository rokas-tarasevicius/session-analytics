#!/usr/bin/env node
// Post-oracle correlation check for Conductor legacy registrations without IDs.
// Exact raw CWDs and IDs are used only in memory and never emitted.
import {createHash}from'node:crypto';
import{createReadStream,existsSync,readFileSync,readdirSync,realpathSync,writeFileSync}from'node:fs';
import{homedir}from'node:os';import{basename,join,resolve}from'node:path';
import{createInterface}from'node:readline';
import{DatabaseSync}from'../shared/sqlite.ts';
const hash=s=>createHash('sha256').update(s).digest('hex').slice(0,12);
const raw=JSON.parse(readFileSync('.lane/codex-observations.json','utf8'));
const snapshot=JSON.parse(readFileSync(join(homedir(),'session-analytics-lanes/reference/snapshot-noindex-51ea561.json'),'utf8'));
const keyMap=JSON.parse(readFileSync('.lane/codex-key-map.json','utf8'));
const snapshotKeys=new Set(snapshot.sessions.filter(s=>s.provider==='codex').map(s=>s.sessionKey));
const database = new DatabaseSync(join(homedir(), 'Library/Application Support/com.conductor.app/conductor.db'), { readOnly: true });
let registrations;
try { registrations = database.prepare("SELECT s.id,s.created_at,s.claude_session_id,w.workspace_path FROM sessions s JOIN workspaces w ON w.id=s.workspace_id WHERE s.agent_type='codex' ORDER BY datetime(s.created_at) DESC").all(); }
finally { database.close(); }
const directMatches=[];
for(const r of registrations){if(!r.claude_session_id||!snapshotKeys.has(hash(r.id)))continue;const key=hash(`codex:${r.claude_session_id}`);const sessionKey=hash(r.id);if(!keyMap[key])directMatches.push({threadKey:key,sessionKey});keyMap[key]=sessionKey;}
const claimed=new Set(registrations.filter(r=>r.claude_session_id).map(r=>hash(`codex:${r.claude_session_id}`)));
const legacy=registrations.filter(r=>!r.claude_session_id&&snapshotKeys.has(hash(r.id)));
const needed=new Set(raw.sessions.filter(s=>legacy.some(r=>Math.abs(Date.parse(s.metas[0]?.at||s.metaAt)-Date.parse(r.created_at))<=900000)&&!claimed.has(s.metas[0]?.id||s.key)).map(s=>s.metas[0]?.id||s.key));
const candidates=new Map();
const roots=new Set(readdirSync(homedir()).filter(n=>/^\.codex(?:-|$)/.test(n)).map(n=>realpathSync(join(homedir(),n))));
if(process.env.CODEX_HOME&&existsSync(process.env.CODEX_HOME))roots.add(realpathSync(process.env.CODEX_HOME));
function* walk(directory){for(const entry of readdirSync(directory,{withFileTypes:true})){const file=join(directory,entry.name);if(entry.isDirectory())yield*walk(file);else if(entry.isFile()&&entry.name.endsWith('.jsonl'))yield file;}}
const seenFiles=new Set();
for(const root of roots)for(const name of['sessions','archived_sessions']){const directory=join(root,name);if(!existsSync(directory))continue;for(const file of walk(directory)){
  const canonical=realpathSync(file);if(seenFiles.has(canonical))continue;seenFiles.add(canonical);
  const id=basename(file).match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.jsonl$/i)?.[1];
  if(id&&!needed.has(hash(`codex:${id}`)))continue;
  const lines=createInterface({input:createReadStream(file),crlfDelay:Infinity});
  for await(const line of lines){let r;try{r=JSON.parse(line);}catch{continue;}if(r.type!=='session_meta')continue;const p=r.payload;const key=hash(`codex:${p.id}`);if(needed.has(key)&&typeof p.cwd==='string')candidates.set(key,{key,cwd:resolve(p.cwd),at:r.timestamp});break;}
}}
const matches=[];
for(const registration of legacy){const possible=[...candidates.values()].filter(c=>!claimed.has(c.key)&&c.cwd===resolve(registration.workspace_path)&&Math.abs(Date.parse(c.at)-Date.parse(registration.created_at))<=900000);
 if(possible.length!==1)continue;const c=possible[0];const sessionKey=hash(registration.id);claimed.add(c.key);keyMap[c.key]=sessionKey;
 matches.push({threadKey:c.key,sessionKey,exactWorkingDirectoryMatch:true,unclaimedCandidates:possible.length,startDifferenceMilliseconds:Date.parse(c.at)-Date.parse(registration.created_at)});
}
writeFileSync('.lane/codex-key-map.json',`${JSON.stringify(keyMap,null,2)}\n`);
writeFileSync('.lane/codex-legacy-key-map.json',`${JSON.stringify({legacyRegistrationsPresentInSnapshot:legacy.length,rawCandidatesInspected:candidates.size,directMatches,matches},null,2)}\n`);
console.log(JSON.stringify({legacyRegistrationsPresentInSnapshot:legacy.length,rawCandidatesInspected:candidates.size,directMatches,matches},null,2));
