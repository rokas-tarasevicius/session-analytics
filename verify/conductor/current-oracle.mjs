import { addEvent, compareEventBuckets } from '../shared/event-buckets.ts';
/** Integration oracle over raw SDK envelopes. No production imports.
 * Independent physical counters/pricing come from the Claude oracle. Receipt
 * comparison checks the conservative observed-floor policy, never an invoice.
 */
import fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from '../shared/sqlite.ts';
import { counters, zero, keys } from '../claude/oracle.mjs';
import { price } from '../claude/pricing.mjs';
const snapshot=JSON.parse(fs.readFileSync(process.env.SESSION_ANALYTICS_VERIFY_REFERENCE??'../reference/snapshot-noindex-51ea561.json','utf8'));
const calibrationOnly=process.argv.includes('--calibration');
const hash=s=>createHash('sha256').update(String(s)).digest('hex').slice(0,12);
const date=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))?new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(v)?v:v+'Z').toISOString():null;
const finite=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;
const number=v=>finite(v)??0;
const model=v=>typeof v==='string'&&/^claude-[a-zA-Z0-9._:-]+(?:\[1m\])?$/.test(v)?v.replace(/\[1m\]$/,''):'<unknown>';
const add=(a,b)=>{for(const k of keys)a[k]+=b[k]??0;};
const total=u=>u.inputTokens+u.outputTokens;
const parse=s=>{try{const d=JSON.parse(s);return d&&typeof d==='object'&&!Array.isArray(d)?d:null}catch{return null}};
const local=u=>{const t=counters(u??{});t.reasoningOutputTokens=0;t.nonReasoningOutputTokens=t.outputTokens;return t;};
const byKey=new Map(snapshot.sessions.map(s=>[s.sessionKey,s]));
const db=new DatabaseSync(process.env.CONDUCTOR_DATABASE??join(homedir(),'Library/Application Support/com.conductor.app/conductor.db'),{readOnly:true});
const registrations=db.prepare("SELECT id,claude_session_id,created_at,updated_at FROM sessions WHERE agent_type='claude'").all();
const query=db.prepare('SELECT id,content,full_message,created_at,sdk_message_id FROM session_messages WHERE session_id=? ORDER BY created_at,id');
const groups=new Map();
for(const registration of registrations){
 let version=null;const seenInit=new Set(),events=[],links=[],queryReceipts=new Set();let latest=calibrationOnly?null:date(registration.updated_at),queryStart=0;
 for(const row of query.iterate(registration.id)){
  const at=date(row.created_at);if(calibrationOnly&&at&&at>snapshot.generatedAt)continue;if(at&&(!latest||at>latest))latest=at;
  for(const d of [parse(row.content),parse(row.full_message)].filter(Boolean)){
   const id=d.uuid??`row:${row.id}`;
   if(d.type==='system'&&d.subtype==='init'&&!seenInit.has(id)){seenInit.add(id);const v=/^2\.1\.(\d+)$/.exec(d.claude_code_version??'');version=v&&+v[1]<277?'old':v?'restored':null;continue;}
   if(d.type==='conversation_reset'){if(d.session_id&&d.new_conversation_id)links.push([d.session_id,d.new_conversation_id]);continue;}
   if(!['assistant','result'].includes(d.type))continue;
   if(calibrationOnly&&date(d.timestamp)>snapshot.generatedAt)continue;
   events.push({d,id,at:date(d.timestamp)??at,receiptAt:at,recordId:d.uuid??row.sdk_message_id??`row:${row.id}`,version});
   if(d.type==='result'&&!queryReceipts.has(id)&&(finite(d.total_cost_usd)!==null||d.usage||d.modelUsage)){
    for(let i=queryStart;i<events.length-1;i++)if(events[i].d.type==='assistant')events[i].queryId=id;
    queryStart=events.length;queryReceipts.add(id);
   }
  }
 }
 const accepted=new Set(registration.claude_session_id?[registration.claude_session_id]:[]);
 for(let i=0;i<links.length;i++)for(const [a,b]of links)if(accepted.has(a)||accepted.has(b)){accepted.add(a);accepted.add(b);}
 for(const event of events){const {d}=event;if(d.session_id&&registration.claude_session_id&&!accepted.has(d.session_id))continue;
  const identity=d.session_id??registration.claude_session_id??`row:${registration.id}`,id=`claude:${identity}`;
  let g=groups.get(id);if(!g){g={nativeKey:hash(id),id,registrations:new Map(),messages:[],receipts:new Map(),latest};groups.set(id,g)}
  g.registrations.set(registration.id,registration);if(latest&&(!g.latest||latest>g.latest))g.latest=latest;
  if(d.type==='assistant'){
   if(!d.session_id&&!d.message?.id&&!d.uuid&&!event.recordId)continue;
   const u=d.message?.usage;const t=counters(u??{}),m=model(d.message?.model),identity=d.message?.id??d.requestId;
   const inputKey=JSON.stringify([d.parent_tool_use_id??null,d.agentId??null,d.isSidechain===true||d.isSidechain===1,m,t.uncachedInputTokens,t.cachedInputTokens,t.cacheWriteInputTokens]);
   const statisticsTokens=['input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens'].reduce((n,k)=>n+(Number.isSafeInteger(u?.[k])&&u[k]>=0?u[k]:0),0);
   g.messages.push({queryId:event.queryId,statisticsTokens,recordId:event.recordId,id:identity?`response:${identity}`:`unidentified:${inputKey}`,known:!!identity,inputKey,at:event.at,model:m,tokens:t,thinking:finite(u?.output_tokens_details?.thinking_tokens)!==null,observed:!!u&&['input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens'].some(k=>finite(u[k])!==null),child:!!d.parent_tool_use_id||d.isSidechain===true||d.isSidechain===1});
  }else{
   if(finite(d.total_cost_usd)===null&&!d.usage&&!d.modelUsage)continue;
   const models=Object.entries(d.modelUsage??{}).map(([m,u])=>({model:model(m),tokens:local({input_tokens:u.inputTokens,cache_read_input_tokens:u.cacheReadInputTokens,cache_creation_input_tokens:u.cacheCreationInputTokens,output_tokens:u.outputTokens}),cost:number(u.costUSD),costObserved:finite(u.costUSD)!==null,observed:['inputTokens','outputTokens','cacheReadInputTokens','cacheCreationInputTokens'].some(k=>finite(u[k])!==null)}));
   const t=zero();for(const m of models)add(t,m.tokens);
   const r={id:event.id,at:event.receiptAt,version:event.version,cost:finite(d.total_cost_usd),marginal:finite(d.conductor_sdk_metadata?.marginalCostUsd),models,tokens:t,observed:models.some(m=>m.observed),local:d.usage?local(d.usage):null,reason:d.terminal_reason??d.subtype};
   const old=g.receipts.get(r.id);if(!old||(r.at??'')<(old.at??''))g.receipts.set(r.id,r);
  }
 }
}
db.close();
const differences=[],sessions=[],excluded=[],unmatched=[],residuals=[],pairs=[];
const delta=(key,field,actual,expected)=>{if(typeof actual==='number'&&typeof expected==='number'&&(/Usd|USD/.test(field)?Math.abs(actual-expected)<=1e-7:actual===expected))return;if(actual===expected)return;differences.push({sessionKey:key,field,actual:actual??null,expected:expected??null});};
const wins=(a,b)=>!a||b.tokens.outputTokens>a.tokens.outputTokens||(b.tokens.outputTokens===a.tokens.outputTokens&&total(b.tokens)>0&&(total(a.tokens)===0||b.thinking&&!a.thinking));
for(const g of groups.values()){
 const regs=[...g.registrations.values()],registered=regs.filter(r=>r.claude_session_id&&g.id===`claude:${r.claude_session_id}`);
 const key=registered.length===1?hash(registered[0].id):g.nativeKey;
 const ref=byKey.get(key)??byKey.get(g.nativeKey);
 if(g.latest&&g.latest>snapshot.generatedAt){excluded.push({sessionKey:key,reason:'activity-after-snapshot',lastObservedAt:g.latest,snapshotTokens:ref?.tokens??null,snapshotUsd:ref?.cost.totalUsd??null});continue;}
 if(!ref){const positiveUsageBlocks=g.messages.filter(m=>m.observed&&total(m.tokens)>0).length,positiveReceipts=[...g.receipts.values()].filter(r=>(r.cost??0)>0||total(r.tokens)>0||r.local&&total(r.local)>0).length;unmatched.push({sessionKey:key,messages:g.messages.length,receipts:g.receipts.size,positiveUsageBlocks,positiveReceipts,reason:positiveUsageBlocks||positiveReceipts?'positive-unprojected-evidence':'no-positive-usage-evidence'});continue;}
 const nativePair=ref.provider==='claude'&&!ref.evidence&&ref.transcript.files>0&&!ref.transcript.sourceDeleted;
 if(calibrationOnly?!nativePair:!['conductor-messages','conductor-result'].includes(ref.evidence?.source))continue;
 delta(key,'sessionKey',ref.sessionKey,key);
 const receipts=[...g.receipts.values()],valid=receipts.filter(r=>!(r.reason==='error_during_execution'&&!r.cost&&!total(r.tokens)));
 const ordered=valid.sort((a,b)=>(a.at??'').localeCompare(b.at??'')||a.id.localeCompare(b.id));
 const last=ordered.at(-1),dominates=last&&ordered.every(r=>(r.cost===null||(last.cost??-1)>=r.cost)&&(!r.observed||last.observed)&&keys.every(k=>last.tokens[k]>=r.tokens[k]));
 const selected=dominates?last:[...valid].sort((a,b)=>(b.cost??0)-(a.cost??0)||b.tokens.inputTokens-a.tokens.inputTokens||(b.at??'').localeCompare(a.at??''))[0];
 const marginal=receipts.filter(r=>r.version==='old'&&r.marginal!==null),marginalTotal=marginal.reduce((n,r)=>n+r.marginal,0);
 const completeMarginal=marginal.length>0&&receipts.every(r=>!(r.reason==='error_during_execution'&&!r.cost&&!total(r.tokens))&&(r.cost===0||r.version==='old'&&r.marginal!==null));
 let reported=selected?(selected.cost??selected.models.reduce((n,m)=>n+m.cost,0)):null;
 if(marginal.length)reported=completeMarginal?marginalTotal:Math.max(reported??0,marginalTotal);
 if(g.messages.some(m=>m.observed)){
  const recordAliases=new Map(g.messages.filter(m=>m.known).map(m=>[m.recordId,m.id])),records=new Map(),requests=new Map();
  for(const m of [...g.messages].sort((a,b)=>(a.at??'\uffff').localeCompare(b.at??'\uffff')))if(wins(records.get(m.recordId),m))records.set(m.recordId,m);
  const merge=(id,m)=>{const previous=requests.get(id);if(wins(previous,m))requests.set(id,{...m,id,at:previous&&total(previous.tokens)>0?previous.at??m.at:m.at});};
  for(const m of records.values())merge(recordAliases.get(m.recordId)??m.id,{...m,known:recordAliases.has(m.recordId)||m.known});
  const known=new Map();for(const m of requests.values())if(m.known&&(!known.has(m.inputKey)||known.get(m.inputKey).tokens.outputTokens<m.tokens.outputTokens))known.set(m.inputKey,m);
  for(const m of [...requests.values()])if(!m.known&&known.has(m.inputKey)){requests.delete(m.id);merge(known.get(m.inputKey).id,m);requests.get(known.get(m.inputKey).id).known=false;}
  const statistics=new Map();for(const m of records.values())if(m.at&&m.model!=='<unknown>'&&m.statisticsTokens){const id=m.at.slice(0,10)+':'+m.model;statistics.set(id,(statistics.get(id)??0)+m.statisticsTokens);}
  const actualStatistics=new Map((ref.historyStatistics?.days??[]).map(r=>[r.day+':'+r.model,r.tokens]));
  for(const id of new Set([...statistics.keys(),...actualStatistics.keys()]))delta(key,`streamStatistics.${id}`,actualStatistics.get(id)??0,statistics.get(id)??0);
  const eventBuckets=new Map();
  const tokens=zero(),models=new Map(),days={},execution={topLevelUsd:0,subagentUsd:0,unknownUsd:0};let usd=0,calls=0;
  for(const m of requests.values())if(total(m.tokens)>0){const t=m.tokens;add(tokens,t);calls++;const cost=price(m.model,{input:t.uncachedInputTokens,cacheRead:t.cachedInputTokens,cacheWrite5m:t.cacheWrite5mInputTokens,cacheWrite1h:t.cacheWrite1hInputTokens,cacheWriteUnknown:Math.max(0,t.cacheWriteInputTokens-t.cacheWrite5mInputTokens-t.cacheWrite1hInputTokens),output:t.outputTokens},m.at).costUSD;
   addEvent(eventBuckets,{at:m.at,model:m.model,executionKind:m.child?'subagent':'top-level',tokens:t,totalUsd:cost,calls:1},snapshot.velocity?.timeZone??'Europe/London');
   usd+=cost;execution[m.child?'subagentUsd':'topLevelUsd']+=cost;if(m.at){const d=m.at.slice(0,10);days[d]=(days[d]??0)+cost;}
   const mo=models.get(m.model)??{tokens:zero(),usd:0,calls:0};add(mo.tokens,t);mo.usd+=cost;mo.calls++;models.set(m.model,mo);
  }
  // Independently reconcile query-local output against the retained main-loop
  // physical inputs. Cumulative modelUsage/cost never supply additive output.
  let outputRecovered=0;
  const occurrences=new Map();
  for(const m of g.messages)if(m.queryId&&!m.child)for(const id of [m.recordId,...(m.known?[m.id]:[])]){const set=occurrences.get(id)??new Set();set.add(m.queryId);occurrences.set(id,set);}
  for(const receipt of receipts){
   const source=g.messages.filter(m=>m.queryId===receipt.id&&!m.child),target=receipt.local;
   if(!source.length||!target?.inputTokens||source.some(m=>!m.observed||occurrences.get(m.recordId).size>1||m.known&&occurrences.get(m.id).size>1))continue;
   const aliases=new Map(source.filter(m=>m.known).map(m=>[m.recordId,m.id])),records=new Map(),groups=new Map();
   for(const m of source)if(wins(records.get(m.recordId),m))records.set(m.recordId,m);
   for(const m of records.values()){const id=aliases.get(m.recordId)??m.id;if(wins(groups.get(id),m))groups.set(id,{...m,id,known:m.known||aliases.has(m.recordId)});}
   const knownInputs=new Set([...groups.values()].filter(m=>m.known).map(m=>m.inputKey));
   if([...groups.values()].some(m=>!m.known&&knownInputs.has(m.inputKey)))continue;
   const names=new Set([...groups.values()].map(m=>m.model));if(names.size!==1||names.has('<unknown>'))continue;
   const observed=zero();for(const m of groups.values())add(observed,m.tokens);
   if(!['uncachedInputTokens','cachedInputTokens','cacheWriteInputTokens'].every(k=>observed[k]===target[k]))continue;
   const output=target.outputTokens-observed.outputTokens;if(output<=0)continue;
   const times=[...groups.values()].map(m=>m.at),dates=new Set(times.map(t=>t?.slice(0,10)??null)),hours=new Set(times.map(t=>t?.slice(0,13)??null));
   const day=dates.size===1?[...dates][0]:null,at=hours.size===1&&!hours.has(null)?times.find(Boolean):null,model=[...names][0];
   const t=zero();t.outputTokens=output;
   const cost=price(model,{input:0,cacheRead:0,cacheWrite5m:0,cacheWrite1h:0,cacheWriteUnknown:0,output,contextInput:0},at??(day?day+'T12:00:00.000Z':null)).costUSD;
   add(tokens,t);usd+=cost;outputRecovered+=output;execution.topLevelUsd+=cost;
   if(day)days[day]=(days[day]??0)+cost;
   const mo=models.get(model)??{tokens:zero(),usd:0,calls:0};add(mo.tokens,t);mo.usd+=cost;models.set(model,mo);
   addEvent(eventBuckets,{at,model,executionKind:'top-level',tokens:t,totalUsd:cost,calls:0},snapshot.velocity?.timeZone??'Europe/London');
  }
  const floor=reported!==null&&reported>usd+1e-9;
  if(calibrationOnly){pairs.push({sessionKey:ref.sessionKey,valueUsd:floor?reported:usd,receiptFloorApplied:floor});continue;}
  delta(key,'reconciliation.receiptFloorApplied',ref.conductor?.reconciliation?.receiptFloorApplied??false,floor);
  delta(key,'reconciliation.outputTokensRecovered',ref.conductor?.reconciliation?.outputTokensRecovered??0,outputRecovered);
  delta(key,'reconciliation.messageValueUsd',ref.conductor?.reconciliation?.messageValueUsd,usd);
  delta(key,'evidence.source',ref.evidence?.source,floor?'conductor-result':'conductor-messages');
  if(!floor)differences.push(...compareEventBuckets(ref,[...eventBuckets.values()]));
  for(const k of keys)delta(key,`tokens.${k}`,ref.tokens[k],tokens[k]);delta(key,'cost.totalUsd',ref.cost.totalUsd,floor?reported:usd);delta(key,'metrics.modelCalls',ref.metrics.modelCalls,calls);
  delta(key,'metrics.assistantMessages',ref.metrics.assistantMessages,requests.size);
  const expectedDays=floor?{}:days;
  for(const d of new Set([...Object.keys(expectedDays),...Object.keys(ref.spendByDay)]))delta(key,`day.${d}.Usd`,ref.spendByDay[d]??0,expectedDays[d]??0);
  const reportedModels=new Map();for(const m of selected?.models??[])reportedModels.set(m.model,(reportedModels.get(m.model)??0)+m.cost);
  const allocated=[...reportedModels.values()].reduce((n,v)=>n+v,0),balance=Math.max(0,(reported??0)-allocated);
  if(balance>1e-6)reportedModels.set('<unknown>',(reportedModels.get('<unknown>')??0)+balance);
  for(const model of new Set([...models.keys(),...ref.models.map(m=>m.model),...(floor?reportedModels.keys():[])])){
   const m=models.get(model),rm=ref.models.find(r=>r.model===model);for(const k of keys)delta(key,`model.${model}.${k}`,rm?.[k]??0,m?.tokens[k]??0);
   delta(key,`model.${model}.totalUsd`,rm?.totalUsd??0,floor?reportedModels.get(model)??0:m?.usd??0);delta(key,`model.${model}.calls`,rm?.calls??0,m?.calls??0);
  }
  const expectedExecution=floor?{topLevelUsd:0,subagentUsd:0,unknownUsd:reported}:execution;
  for(const k of Object.keys(execution))delta(key,`execution.${k}`,ref.costByExecution[k],expectedExecution[k]);
  delta(key,'reconciliation.reportedUsd',ref.conductor?.reconciliation?.reportedUsd,reported);
  const missingIdentity=[...requests.values()].filter(m=>!m.known).length;
  delta(key,'reconciliation.messagesWithoutIdentity',ref.conductor?.reconciliation?.messagesWithoutIdentity,missingIdentity);
  delta(key,'reconciliation.messagesWithoutUsage',ref.conductor?.reconciliation?.messagesWithoutUsage,[...requests.values()].filter(m=>!m.observed).length);
  delta(key,'costComplete',ref.costComplete,false);
  sessions.push({sessionKey:key,source:floor?'conductor-result':'conductor-messages',tokens:total(tokens),usd:floor?reported:usd,calls,reportedUsd:reported,missingIdentity});
  if(missingIdentity)residuals.push({sessionKey:key,reason:'stripped-response-identity-observed-input-groups',groups:missingIdentity,observedTokens:total(tokens),observedUsd:usd,reportedUsd:reported});
 }else{
  if(calibrationOnly){pairs.push({sessionKey:ref.sessionKey,valueUsd:reported??0,receiptFloorApplied:false});continue;}
  const expected=selected?.observed?selected.tokens:zero();if(!selected?.observed)for(const r of receipts)if(r.local)add(expected,r.local);
  for(const k of keys)delta(key,`tokens.${k}`,ref.tokens[k],expected[k]);delta(key,'cost.totalUsd',ref.cost.totalUsd,reported??0);delta(key,'datedUsd',Object.values(ref.spendByDay).reduce((n,v)=>n+v,0),0);
  const models=new Map();for(const m of selected?.models??[]){const prior=models.get(m.model)??{tokens:zero(),usd:0};add(prior.tokens,m.tokens);prior.usd+=m.cost;models.set(m.model,prior);}
  const allocated=zero();let allocatedUsd=0;for(const m of models.values()){add(allocated,m.tokens);allocatedUsd+=m.usd;}
  const remainder=zero();if(keys.every(k=>allocated[k]<=expected[k]))for(const k of keys)remainder[k]=expected[k]-allocated[k];const remainderUsd=Math.max(0,(reported??0)-allocatedUsd);
  if(total(remainder)||remainderUsd>1e-6){const u=models.get('<unknown>')??{tokens:zero(),usd:0};add(u.tokens,remainder);u.usd+=remainderUsd;models.set('<unknown>',u);}
  for(const model of new Set([...models.keys(),...ref.models.map(m=>m.model)])){const m=models.get(model),r=ref.models.find(m=>m.model===model);for(const k of keys)delta(key,`model.${model}.${k}`,r?.[k]??0,m?.tokens[k]??0);delta(key,`model.${model}.totalUsd`,r?.totalUsd??0,m?.usd??0);}
  sessions.push({sessionKey:key,source:'conductor-result',tokens:total(expected),usd:reported??0,receipts:receipts.length});
  if(receipts.length>1)residuals.push({sessionKey:key,reason:'cumulative-receipts-do-not-prove-disjoint-epochs',receipts:receipts.length,retainedUsd:reported??0,retainedTokens:total(expected)});
 }
}
const covered=new Set([...sessions,...excluded].map(s=>s.sessionKey));for(const s of snapshot.sessions)if(['conductor-messages','conductor-result'].includes(s.evidence?.source)&&!covered.has(s.sessionKey))differences.push({sessionKey:s.sessionKey,field:'independentCoverage',actual:true,expected:false});
const result={generatedAt:snapshot.generatedAt,summary:{sessions:sessions.length,differences:differences.length,excludedLive:excluded.length,partialEvidence:residuals.length,tokens:sessions.reduce((n,s)=>n+s.tokens,0),usd:sessions.reduce((n,s)=>n+s.usd,0)},sessions,differences,excluded,residuals,unmatched};
fs.writeFileSync(calibrationOnly?'.lane/calibration-pairs.json':'.lane/conductor-current.json',JSON.stringify(calibrationOnly?{generatedAt:snapshot.generatedAt,pairs}:result,null,2));console.log(JSON.stringify(calibrationOnly?{pairs:pairs.length}:result.summary));
