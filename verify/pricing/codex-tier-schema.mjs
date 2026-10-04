/** Read-only, bounded metadata scan. Content strings are never parsed or exported. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createInterface } from 'node:readline';
import { DatabaseSync } from '../shared/sqlite.ts';
const cutoffText=JSON.parse(fs.readFileSync('.lane/codex-adjudication.json','utf8')).referenceGeneratedAt;
const cutoff=Date.parse(cutoffText),maxCharacters=16*1024*1024;
const fieldNames=new Set(['service_tier','serviceTier','requested_service_tier','actual_service_tier','service_tier_requested','service_tier_response','speed','fast_mode','fastMode','fast_mode_enabled']);
const children=new Set(['payload','info','settings','thread_settings','collaboration_mode','usage','total_token_usage','last_token_usage','response','request','result','metadata','config','model_settings','token_usage','details']);
const topTypes=new Set(['turn_context','session_meta','event_msg','response_item','compacted']);
const eventTypes=new Set(['token_count','token_usage_record','task_started','task_complete','item_completed','response_completed','response_done','turn_aborted','thread_settings_applied']);
const labels=new Set(['auto','default','standard','priority','flex','fast','batch','scale']);
const marker=/(?<!\\)"(?:service_tier|serviceTier|requested_service_tier|actual_service_tier|service_tier_requested|service_tier_response|speed|fast_mode|fastMode|fast_mode_enabled)"\s*:/;
const roots=new Set();
const hash=s=>crypto.createHash('sha256').update(s).digest('hex').slice(0,12);
const validModel=v=>typeof v==='string'&&v.length<=128&&/^(?:openai\/)?(?:gpt-\d+(?:[.-]\d+)*[a-z]?(?:-(?:codex|spark|sol|terra|astra|mini|nano|pro|preview|turbo|max|latest|\d{4}-\d{2}-\d{2}|\d{8}))*|chatgpt-\d+(?:[.-]\d+)*-latest|o[1-9](?:-mini|-pro)?(?:-\d{4}-\d{2}-\d{2})?)$/i.test(v);
const rawToConductor=new Map();
try{const db=new DatabaseSync(path.join(os.homedir(),'Library/Application Support/com.conductor.app/conductor.db'),{readOnly:true});for(const row of db.prepare("SELECT id,claude_session_id FROM sessions WHERE agent_type='codex' ORDER BY datetime(created_at) ASC").all())if(row.claude_session_id)rawToConductor.set(row.claude_session_id,hash(row.id));db.close();}catch{}
const identity=JSON.parse(fs.readFileSync('.lane/codex-identity.json','utf8'));
const legacyKeys=new Map(identity.legacyMatches.filter(m=>!m.registeredCandidate).map(m=>[m.rawSessionKey,m.referenceSessionKey]));
for(const e of fs.readdirSync(os.homedir(),{withFileTypes:true}))if((e.isDirectory()||e.isSymbolicLink())&&/^\.codex(?:-|$)/.test(e.name))for(const child of ['sessions','archived_sessions'])try{roots.add(fs.realpathSync(path.join(os.homedir(),e.name,child)))}catch{}
if(process.env.CODEX_HOME)for(const child of ['sessions','archived_sessions'])try{roots.add(fs.realpathSync(path.join(process.env.CODEX_HOME,child)))}catch{}
function* walk(dir){let es;try{es=fs.readdirSync(dir,{withFileTypes:true})}catch{return;}for(const e of es){const p=path.join(dir,e.name);if(e.isDirectory())yield*walk(p);else if(e.isFile()&&e.name.endsWith('.jsonl'))yield p;}}
const counts={files:0,lines:0,preReferenceLines:0,postReferenceLines:0,undatedLines:0,matchingKeyLines:0,parsedMetadataCandidates:0,malformedCandidates:0,oversizedCandidates:0,unreadableFiles:0,boundedTraversals:0,boundedSchemaTraversals:0,candidatesWithStructuredKeys:0,candidatesWithoutStructuredKeys:0,turnContexts:0,tokenCountEvents:0,tokenUsageRecordEvents:0};
const fields={},selectedPaths={},structuredFields={},candidateRecordTypes={},candidatePayloadTypeEnums={},directEventTierContainers={};
const settingsEvents=[],settingsShapes={};
// This second pass classifies structured keys beyond the receipt allowlist. It
// never parses a content string, emits arbitrary keys, or retains a raw value.
const schemaChildren=new Set([...children,'content','replacement_history','items','item','message','messages','arguments','input','output','rate_limits','primary','secondary']);
const requiredPaths=['turn_context.payload.service_tier','turn_context.payload.settings.service_tier','turn_context.payload.collaboration_mode.settings.service_tier','event_msg.token_count.payload.service_tier','event_msg.token_count.payload.info.service_tier','event_msg.token_usage_record.payload.service_tier'];for(const p of requiredPaths)selectedPaths[p]=0;
function label(v){return v===null?'null':typeof v==='boolean'?String(v):typeof v==='string'&&labels.has(v.toLowerCase())?v.toLowerCase():'unrecognized';}
// Provider record type and direct field names are schema enums, never values
// from content. Bound their grammar and length before retaining them.
function schemaEnum(v){return typeof v==='string'&&/^[a-z][a-z_]{0,47}$/.test(v)?v:'unrecognized';}
function inspect(r,fileState){const top=topTypes.has(r.type)?r.type:'other_record';const type=top==='event_msg'?(eventTypes.has(r.payload?.type)?top+'.'+r.payload.type:top+'.other_event'):top;let visited=0;
 candidateRecordTypes[type]=(candidateRecordTypes[type]??0)+1;
 const payloadType=top+'.'+schemaEnum(r.payload?.type);candidatePayloadTypeEnums[payloadType]=(candidatePayloadTypeEnums[payloadType]??0)+1;
 if(top==='event_msg'&&r.payload&&typeof r.payload==='object')for(const [key,v] of Object.entries(r.payload))if(v&&typeof v==='object'&&!Array.isArray(v)&&Object.hasOwn(v,'service_tier')){const p=payloadType+'.payload.'+schemaEnum(key)+'.service_tier';const entry=directEventTierContainers[p]??={occurrences:0,labels:{}};entry.occurrences++;const l=label(v.service_tier);entry.labels[l]=(entry.labels[l]??0)+1;}
 if(top==='event_msg'&&r.payload?.type==='thread_settings_applied'){
  const s=r.payload.thread_settings??{},t=Date.parse(r.timestamp);
  const model=validModel(s.model)?s.model:fileState.model;
  settingsEvents.push({sessionKey:fileState.key||'unavailable',time:Number.isFinite(t)?new Date(t).toISOString():null,tier:label(s.service_tier),model,validIdentity:fileState.valid});
  const shape=Object.entries(s).map(([k,v])=>schemaEnum(k)+':'+(v===null?'null':Array.isArray(v)?'array':typeof v)).sort().join(',');settingsShapes[shape]=(settingsShapes[shape]??0)+1;
 }
 function visit(value,parts,depth){if(!value||typeof value!=='object'||Array.isArray(value))return;if(depth>8||++visited>200){counts.boundedTraversals++;return;}
  for(const key of fieldNames)if(Object.hasOwn(value,key)){const p=[type,...parts,key].join('.');const entry=fields[p]??={occurrences:0,labels:{}};entry.occurrences++;const l=label(value[key]);entry.labels[l]=(entry.labels[l]??0)+1;if(Object.hasOwn(selectedPaths,p))selectedPaths[p]++;}
  for(const key of children)if(Object.hasOwn(value,key))visit(value[key],[...parts,key],depth+1);
 }visit(r,[],0);
 let structuredVisited=0,found=false;
 function schemaVisit(value,parts,depth){if(!value||typeof value!=='object')return;if(depth>32||++structuredVisited>100000){counts.boundedSchemaTraversals++;return;}
  if(Array.isArray(value)){for(const item of value)schemaVisit(item,[...parts,'array'],depth+1);return;}
  for(const [key,v] of Object.entries(value)){
   if(fieldNames.has(key)){found=true;const p=[type,...parts,key].join('.');const entry=structuredFields[p]??={occurrences:0,labels:{}};entry.occurrences++;const l=label(v);entry.labels[l]=(entry.labels[l]??0)+1;}
   if(v&&typeof v==='object')schemaVisit(v,[...parts,schemaChildren.has(key)?key:'other'],depth+1);
  }
 }schemaVisit(r,[],0);
 if(found)counts.candidatesWithStructuredKeys++;else counts.candidatesWithoutStructuredKeys++;
}
for(const root of roots)for(const file of walk(root)){counts.files++;const fileState={key:'',model:'unknown',valid:false,seenMeta:false};try{for await(const line of createInterface({input:fs.createReadStream(file),crlfDelay:Infinity})){
 counts.lines++;const prefix=line.slice(0,768),stamp=/^\s*\{\s*"timestamp"\s*:\s*"([^"\\]{1,50})"/.exec(prefix)?.[1],time=Date.parse(stamp??'');
 if(Number.isFinite(time)&&time>cutoff){counts.postReferenceLines++;continue;}if(Number.isFinite(time))counts.preReferenceLines++;else counts.undatedLines++;
 const top=/"type"\s*:\s*"([a-z_]+)"\s*,\s*"payload"\s*:/.exec(prefix)?.[1];
 if(top==='session_meta'||top==='turn_context'){try{const r=JSON.parse(line),q=r.payload??{};if(top==='session_meta'&&!fileState.seenMeta){fileState.seenMeta=true;fileState.valid=typeof q.id==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(q.id)&&path.basename(file).endsWith(q.id+'.jsonl')&&typeof q.cwd==='string'&&q.cwd.length>0;if(typeof q.id==='string'){const key=rawToConductor.get(q.id)??hash('codex:'+q.id);fileState.key=legacyKeys.get(key)??key;}}if(top==='turn_context'&&validModel(q.model))fileState.model=q.model;}catch{}}
 if(top==='turn_context')counts.turnContexts++;if(top==='event_msg'&&/"payload"\s*:\s*\{\s*"type"\s*:\s*"token_count"/.test(prefix))counts.tokenCountEvents++;
 if(top==='event_msg'&&/"payload"\s*:\s*\{\s*"type"\s*:\s*"token_usage_record"/.test(prefix))counts.tokenUsageRecordEvents++;
 if(!marker.test(line))continue;counts.matchingKeyLines++;if(line.length>maxCharacters){counts.oversizedCandidates++;continue;}let r;try{r=JSON.parse(line)}catch{counts.malformedCandidates++;continue;}if(!r||typeof r!=='object'||Array.isArray(r))continue;counts.parsedMetadataCandidates++;inspect(r,fileState);
 }}catch{counts.unreadableFiles++;}
 if(counts.files%1000===0)console.error(JSON.stringify({filesRead:counts.files}));}
const result={referenceGeneratedAt:cutoffText,method:'Explicit service/speed keys at allowlisted metadata object paths, followed by bounded structural-only classification of candidate lines; content strings are never parsed or exported',counts,selectedPaths,fields,candidateRecordTypes,candidatePayloadTypeEnums,directEventTierContainers,structuredFields,limits:['Context/settings fields describe request configuration; only a receipt field could provide stronger evidence of the applied service tier.','Absent metadata is unavailable, not default/standard service.','The receipt projection follows allowlisted metadata containers to depth eight and 200 objects per candidate; arrays and unknown containers are not traversed in that projection.','A separate structural classification follows objects/arrays to depth 32 and 100000 objects per candidate; only static allowlisted structural key names survive and every other name becomes other.','Payload type enums and direct event container field names use a bounded lowercase/underscore schema grammar; no content value is inspected.','Only exact recognized service labels and booleans survive; other values become unrecognized.','Only exact unescaped key spellings are scanned; JSON-escaped key spellings and fields with other names are outside this scan.']};
const settingsSummary={events:settingsEvents.length,sessions:new Set(settingsEvents.map(e=>e.sessionKey)).size,validIdentityEvents:settingsEvents.filter(e=>e.validIdentity).length,byTier:{},byModel:{},byMonth:{},settingsShapes};
for(const e of settingsEvents){for(const [target,key] of [[settingsSummary.byTier,e.tier],[settingsSummary.byModel,e.model],[settingsSummary.byMonth,e.time?.slice(0,7)??'undated']]){const row=target[key]??={events:0,default:0,priority:0};row.events++;if(e.tier==='default'||e.tier==='priority')row[e.tier]++;}}
result.settingsSummary=settingsSummary;
const validEvents=settingsEvents.filter(e=>e.validIdentity),priorityEvents=validEvents.filter(e=>e.tier==='priority');
const validIdentitySummary={validEvents:validEvents.length,validSessions:new Set(validEvents.map(e=>e.sessionKey)).size,priorityEvents:priorityEvents.length,prioritySessions:new Set(priorityEvents.map(e=>e.sessionKey)).size,first:validEvents.map(e=>e.time).filter(Boolean).sort()[0]??null,last:validEvents.map(e=>e.time).filter(Boolean).sort().at(-1)??null,models:{},months:{}};
for(const e of validEvents)for(const [target,key]of [[validIdentitySummary.models,e.model],[validIdentitySummary.months,e.time?.slice(0,7)??'undated']]){const row=target[key]??={default:0,priority:0};if(e.tier==='default'||e.tier==='priority')row[e.tier]++;}
result.validIdentitySummary=validIdentitySummary;
fs.writeFileSync('.lane/codex-tier-settings.json',JSON.stringify({referenceGeneratedAt:cutoffText,method:'Session configuration events only; these do not establish a processed response service tier',summary:settingsSummary,validIdentitySummary,events:settingsEvents},null,2)+'\n');
fs.writeFileSync('.lane/codex-tier-schema.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
