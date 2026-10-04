/** Scoped follow-up: classify only disputed owners' preceding event shapes. Never persists payloads. */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {createHash} from 'node:crypto';
const hash=x=>createHash('sha256').update(x).digest('hex').slice(0,12);
const report=JSON.parse(fs.readFileSync('.lane/codex-owner-audit.json','utf8'));
const targets=new Map();for(const r of report.changed){if(!targets.has(r.oldKey))targets.set(r.oldKey,new Map());targets.get(r.oldKey).set(r.signature,r)}
const vector=u=>['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens','cache_write_input_tokens'].map(k=>Number.isFinite(u?.[k])&&u[k]>=0?u[k]:0);
let files=[];function walk(p){try{for(const d of fs.readdirSync(p,{withFileTypes:true})){const q=path.join(p,d.name);if(d.isDirectory())walk(q);else if(d.name.endsWith('.jsonl')){const id=d.name.match(/([a-f0-9]{8}-[a-f0-9-]{27})(?:_[a-f0-9]{8}-[a-f0-9-]{27})?\.jsonl$/i)?.[1];if(id&&targets.has(hash('codex:'+id)))files.push({path:q,key:hash('codex:'+id)})}}}catch{}}
for(const d of fs.readdirSync(process.env.HOME,{withFileTypes:true}))if(d.isDirectory()&&(d.name==='.codex'||d.name.startsWith('.codex-')))for(const sub of ['sessions','archived_sessions'])walk(path.join(process.env.HOME,d.name,sub));
const types=new Set(['response_item','token_usage_record','event_msg','compacted']);
const subtypes=new Set(['function_call','custom_tool_call','function_call_output','custom_tool_call_output','reasoning','message','item_completed','user_message','agent_message','task_started','task_complete','turn_aborted','world_state','thread_goal_updated']);
const roles=new Set(['assistant','user','system','developer','tool']);
const chosen=new Map();
for(const f of files){let activity=null;for await(const line of readline.createInterface({input:fs.createReadStream(f.path),crlfDelay:Infinity})){let r;try{r=JSON.parse(line)}catch{continue}const p=r.payload??{},t=Date.parse(r.timestamp);const token=r.type==='event_msg'&&p.type==='token_count';if(r.type==='session_meta'||r.type==='turn_context')continue;if(!token&&Number.isFinite(t)){activity={at:t,type:types.has(r.type)?r.type:'other',subtype:subtypes.has(p.type)?p.type:'other',role:roles.has(p.role)?p.role:'none'};continue}if(!token||!p.info||!activity)continue;const signature=hash(JSON.stringify([vector(p.info.total_token_usage),vector(p.info.last_token_usage)]));if(!targets.get(f.key)?.has(signature))continue;const gap=t>=activity.at?t-activity.at:Infinity;const old=chosen.get(signature);if(!old||gap<old.gap||(gap===old.gap&&t<old.at))chosen.set(signature,{key:f.key,at:t,gap,...activity});}}
const counts={};for(const c of chosen.values()){const k=[c.type,c.subtype,c.role].join(':');counts[k]=(counts[k]||0)+1}
const out={targetOwners:targets.size,targetStates:report.changed.length,filesRead:files.length,matchedStates:chosen.size,precedingEventShapes:counts};fs.writeFileSync('.lane/codex-owner-event-shapes.json',JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out,null,2));
