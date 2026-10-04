// Follow up UUID coverage gaps without treating streamed blocks as requests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { DatabaseSync } from '../shared/sqlite.ts';
process.on('uncaughtException', () => { console.error('Partial-coverage validation failed; local details suppressed.'); process.exit(1); });
process.on('unhandledRejection', () => { console.error('Partial-coverage validation failed; local details suppressed.'); process.exit(1); });
const home=os.homedir(), hash=s=>crypto.createHash('sha256').update(s).digest('hex').slice(0,12);
const overlap=JSON.parse(fs.readFileSync('.lane/conductor-overlap.json','utf8'));
const keys=new Set(overlap.sessions.filter(s=>!s.activeAfterCutoff&&s.transcriptEvidence==='partial-sdk-assistant-coverage').map(s=>s.sessionKey));
const db=new DatabaseSync(path.join(home,'Library/Application Support/com.conductor.app/conductor.db'),{readOnly:true});
const ss=db.prepare("SELECT id,claude_session_id FROM sessions WHERE agent_type='claude'").all().filter(s=>keys.has(hash(s.id)));
const selected=new Map(ss.map(s=>[s.claude_session_id,{...s,uuids:new Set(),ids:new Set(),tuples:new Map(),files:0}]));
const tuple=m=>JSON.stringify([m?.model,m?.usage?.input_tokens||0,m?.usage?.cache_read_input_tokens||0,m?.usage?.cache_creation_input_tokens||0]);
function* walk(dir){let es;try{es=fs.readdirSync(dir,{withFileTypes:true});}catch{return;}for(const e of es){const p=path.join(dir,e.name);if(e.isDirectory())yield*walk(p);else if(e.isFile())yield p;}}
const seen=new Set();let parseErrors=0;
for(const e of fs.readdirSync(home))if(e.startsWith('.claude'))for(const p of walk(path.join(home,e,'projects'))){
  if(!p.endsWith('.jsonl'))continue;const rp=fs.realpathSync(p);if(seen.has(rp))continue;seen.add(rp);
  const ds=path.dirname(p).split(path.sep),i=ds.lastIndexOf('subagents');
  const s=selected.get(path.basename(p,'.jsonl'))||(i>0?selected.get(ds[i-1]):null);if(!s)continue;s.files++;
  for await(const line of readline.createInterface({input:fs.createReadStream(p),crlfDelay:Infinity})){
    let x;try{x=JSON.parse(line);}catch{parseErrors++;continue;}if(x?.type!=='assistant')continue;
    if(x.uuid)s.uuids.add(x.uuid);if(x.message?.id)s.ids.add(x.message.id);
    const key=tuple(x.message),ids=s.tuples.get(key)||new Set();if(x.message?.id)ids.add(x.message.id);s.tuples.set(key,ids);
  }
}
const rows=[];
for(const s of selected.values()){
  const out={sessionKey:hash(s.id),files:s.files,missingEnvelopes:0,sameRequestIdSurvives:0,
    sameInputTupleSurvives:0,ambiguousInputTupleSurvives:0,noInputTupleSurvives:0,
    unmatchedTopLevel:0,unmatchedChild:0,missingTupleGroups:0,missingTupleUsage:[]};
  const absentTuples=new Map();
  for(const r of db.prepare("SELECT content FROM session_messages WHERE session_id=? AND role='assistant'").iterate(s.id)){
    let x;try{x=JSON.parse(r.content);}catch{continue;}if(x?.type!=='assistant')continue;
    if(!x.message?.id&&!x.uuid)continue;
    if(x.message?.id?s.ids.has(x.message.id):s.uuids.has(x.uuid))continue;
    out.missingEnvelopes++;
    if(x.message?.id&&s.ids.has(x.message.id))out.sameRequestIdSurvives++;
    const key=tuple(x.message),ids=s.tuples.get(key);
    if(ids?.size){out.sameInputTupleSurvives++;if(ids.size>1)out.ambiguousInputTupleSurvives++;}
    else {out.noInputTupleSurvives++;if(x.parent_tool_use_id)out.unmatchedChild++;else out.unmatchedTopLevel++;
      const model=typeof x.message?.model==='string'&&/^[a-zA-Z0-9._-]+(?:\[1m\])?$/.test(x.message.model)?x.message.model:'<unknown>';
      const u=x.message?.usage||{},v=absentTuples.get(key)||{model,input:u.input_tokens||0,cacheRead:u.cache_read_input_tokens||0,cacheWrite:u.cache_creation_input_tokens||0,output:0,envelopes:0};
      v.envelopes++;v.output=Math.max(v.output,u.output_tokens||0);absentTuples.set(key,v);}
  }
  out.missingTupleGroups=absentTuples.size;out.missingTupleUsage=[...absentTuples.values()];rows.push(out);
}
db.close();
fs.writeFileSync('.lane/conductor-partial-coverage.json',JSON.stringify({parseErrors,
  caution:'Identical input tuples are corroboration, not a unique request identity. UUID gaps alone do not establish missing billed requests.',sessions:rows},null,2)+'\n');
console.log(JSON.stringify(rows));
