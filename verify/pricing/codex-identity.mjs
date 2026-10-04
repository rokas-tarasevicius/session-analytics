import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';import {DatabaseSync} from '../shared/sqlite.ts';import{createInterface}from'node:readline';
const hash=s=>crypto.createHash('sha256').update(s).digest('hex').slice(0,12);
const explained=JSON.parse(fs.readFileSync('.lane/codex-source-explanation.json','utf8'));
const missing=new Set(explained.missingReferenceSessions.filter(r=>!r.rawFileExists).map(r=>r.sessionKey));
const db=new DatabaseSync(os.homedir()+'/Library/Application Support/com.conductor.app/conductor.db',{readOnly:true});
const rows=db.prepare("select s.id,s.claude_session_id,s.created_at,w.workspace_path from sessions s join workspaces w on w.id=s.workspace_id where s.agent_type='codex' order by datetime(s.created_at) ASC").all();db.close();
const map=new Map(rows.filter(r=>r.claude_session_id).map(r=>[r.claude_session_id,hash(r.id)]));
const legacy=rows.filter(r=>missing.has(hash(r.id)));
function*walk(d){let es;try{es=fs.readdirSync(d,{withFileTypes:true})}catch{return;}for(const e of es){const p=path.join(d,e.name);if(e.isDirectory())yield*walk(p);else if(e.isFile()&&e.name.endsWith('.jsonl'))yield p;}}
const roots=new Set();for(const e of fs.readdirSync(os.homedir(),{withFileTypes:true}))if((e.isDirectory()||e.isSymbolicLink())&&/^\.codex(?:-|$)/.test(e.name))for(const c of ['sessions','archived_sessions'])try{roots.add(fs.realpathSync(path.join(os.homedir(),e.name,c)))}catch{}
if(process.env.CODEX_HOME)for(const c of ['sessions','archived_sessions'])try{roots.add(fs.realpathSync(path.join(process.env.CODEX_HOME,c)))}catch{}
let files=0,valid=0,createdAfterReference=0,validBeforeReference=0;const invalid=[],seen=new Map(),matches=[];
for(const root of roots)for(const p of walk(root)){files++;const fileId=path.basename(p).match(/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.jsonl$/)?.[1];const input=fs.createReadStream(p),lines=createInterface({input,crlfDelay:Infinity});let first;
 try{for await(const l of lines){let r;try{r=JSON.parse(l)}catch{continue;}if(r?.type==='session_meta'){first=r;break;}}}finally{lines.close();input.destroy();}
 if(!first)continue;if(Date.parse(first.timestamp)>Date.parse(explained.referenceGeneratedAt))createdAfterReference++;const q=first.payload,rawKey=map.get(q.id)??hash('codex:'+q.id),fileKey=map.get(fileId)??hash('codex:'+fileId);
 if(fileId!==q.id){invalid.push({metadataSessionKey:rawKey,filenameSessionKey:fileKey,timestamp:first.timestamp});continue;}if(!q.cwd)continue;valid++;if(Date.parse(first.timestamp)<=Date.parse(explained.referenceGeneratedAt))validBeforeReference++;
 seen.set(rawKey,(seen.get(rawKey)??0)+1);
 for(const r of legacy)if(r.workspace_path===q.cwd&&Math.abs(Date.parse(/[zZ]|[+-]\d{2}:\d{2}$/.test(r.created_at)?r.created_at:r.created_at+'Z')-Date.parse(first.timestamp))<=15*60*1000)matches.push({referenceSessionKey:hash(r.id),rawSessionKey:rawKey,registeredCandidate:map.has(q.id),timeDifferenceMs:Math.abs(Date.parse(/[zZ]|[+-]\d{2}:\d{2}$/.test(r.created_at)?r.created_at:r.created_at+'Z')-Date.parse(first.timestamp))});
}
const result={createdAfterReference,validBeforeReference,legacyRows:legacy.map(r=>({sessionKey:hash(r.id),providerIdPresent:Boolean(r.claude_session_id),createdAt:r.created_at})),files,valid,invalid,duplicateIdentities:[...seen].filter(([k,n])=>n>1).map(([sessionKey,files])=>({sessionKey,files})),legacyMatches:matches};fs.writeFileSync('.lane/codex-identity.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
