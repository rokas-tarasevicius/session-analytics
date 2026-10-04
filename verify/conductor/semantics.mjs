process.on('uncaughtException', () => { console.error('Oracle failed; private details suppressed.'); process.exit(1); });
process.on('unhandledRejection', () => { console.error('Oracle failed; private details suppressed.'); process.exit(1); });
// Independent raw-data oracle. Deliberately imports no application modules.
// Emits allowlisted numeric metadata, dates, model IDs, enums and hashed keys only.
import { DatabaseSync } from '../shared/sqlite.ts';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

const cutoff = (process.env.ORACLE_CUTOFF ?? '2026-10-03T12:17:26.745Z');
const db = new DatabaseSync(join(homedir(), 'Library/Application Support/com.conductor.app/conductor.db'), {readOnly:true});
const hash = x => createHash('sha256').update(String(x)).digest('hex').slice(0,12);
const num = x => typeof x === 'number' && Number.isFinite(x) ? x : undefined;
const date = x => x && Number.isFinite(Date.parse(x)) ? new Date(x).toISOString() : undefined;
const model = x => typeof x === 'string' && /^claude-[A-Za-z0-9._\[\]-]+$/.test(x) ? x : undefined;
const usageFields = ['input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens'];
const modelFields = ['inputTokens','outputTokens','cacheReadInputTokens','cacheCreationInputTokens','costUSD','webSearchRequests','contextWindow','maxOutputTokens'];
function usage(v={}) {
  const o={}; for(const f of usageFields) if(num(v[f])!==undefined)o[f]=v[f];
  if(v.cache_creation){o.cache_creation={};for(const f of ['ephemeral_5m_input_tokens','ephemeral_1h_input_tokens'])if(num(v.cache_creation[f])!==undefined)o.cache_creation[f]=v.cache_creation[f];}
  return o;
}
function models(v={}) { const o={}; for(const [k,u] of Object.entries(v)){if(!model(k))continue;o[k]={};for(const f of modelFields)if(num(u[f])!==undefined)o[k][f]=u[f];}return o; }
const sessionMap=new Map();
for(const s of db.prepare("select id,claude_session_id,created_at,updated_at,last_user_message_at from sessions where agent_type='claude'").iterate()) sessionMap.set(s.id,{sessionKey:hash(s.id),providerSessionKey:s.claude_session_id?hash('claude:'+s.claude_session_id):undefined,createdAt:date(s.created_at),updatedAt:date(s.updated_at),lastUserMessageAt:date(s.last_user_message_at),latestMessageAt:undefined,results:[],inits:[]});
let invalidJson=0;const types={};
for(const r of db.prepare("select m.session_id,m.content,m.created_at,m.turn_id,m.sdk_message_id from session_messages m join sessions s on s.id=m.session_id where s.agent_type='claude'").iterate()){
  const s=sessionMap.get(r.session_id); const at=date(r.created_at);if(at&&(!s.latestMessageAt||at>s.latestMessageAt))s.latestMessageAt=at;
  let m;try{m=JSON.parse(r.content);}catch{invalidJson++;continue;}
  if(!m||typeof m!=='object'||Array.isArray(m))continue;
  if(typeof m.type==='string'&&['result','system','assistant','user','error'].includes(m.type))types[m.type]=(types[m.type]||0)+1;
  if(m.type==='system'&&m.subtype==='init')s.inits.push({createdAt:at,version:typeof m.claude_code_version==='string'&&/^\d+(\.\d+){1,3}$/.test(m.claude_code_version)?m.claude_code_version:undefined,resultCountBefore:s.results.length});
  if(m.type!=='result')continue;
  const md=m.conductor_sdk_metadata??{};
  const out={createdAt:at,sequence:s.results.length,initCountBefore:s.inits.length,sdkSessionKey:typeof m.session_id==='string'?hash(m.session_id):undefined,uuidKey:typeof m.uuid==='string'?hash(m.uuid):undefined,turnKey:typeof r.turn_id==='string'?hash(r.turn_id):undefined,sdkMessageKey:typeof r.sdk_message_id==='string'?hash(r.sdk_message_id):undefined,totalCostUsd:num(m.total_cost_usd),usage:usage(m.usage),modelUsage:models(m.modelUsage),marginalCostUsd:num(md.marginalCostUsd),foreignResult:typeof md.isForeignResult==='boolean'?md.isForeignResult:undefined,model:model(md.model),requestedModel:model(md.requestedModel),speed:['fast','standard'].includes(md.speed)?md.speed:undefined,serviceTier:['standard','priority','default','batch'].includes(md.serviceTier)?md.serviceTier:undefined,isError:m.is_error===true,numTurns:num(m.num_turns),durationMs:num(m.duration_ms),durationApiMs:num(m.duration_api_ms)};
  s.results.push(out);
}
db.close();
for(const s of sessionMap.values()){s.inits.sort((a,b)=>a.createdAt.localeCompare(b.createdAt));s.results.sort((a,b)=>a.createdAt.localeCompare(b.createdAt));for(const [i,r] of s.results.entries()){r.sequence=i;r.initCountBefore=s.inits.filter(x=>x.createdAt<=r.createdAt).length;}for(const x of s.inits)x.resultCountBefore=s.results.filter(r=>r.createdAt<x.createdAt).length;}
const sessions=[...sessionMap.values()].map(s=>({...s,continuedAfterCutoff:!!((s.latestMessageAt&&s.latestMessageAt>cutoff)||(s.lastUserMessageAt&&s.lastUserMessageAt>cutoff))}));
const summary={sessions:sessions.length,resultRows:0,stableSessions:0,stableResultSessions:0,stableResultRows:0,sumTotalCostUsd:0,sumMarginalCostUsd:0,rowsWithMarginal:0,foreignResultRows:0,duplicateResultUuidRows:0,duplicateResultTurnRows:0,counterDecreases:0,increasesWithoutNewInit:0,decreasesWithoutNewInit:0,modelCostMismatchRows:0,modelCostAbsoluteDiscrepancyUsd:0};
const byMonth={};const perSession=[];
for(const s of sessions){summary.resultRows+=s.results.length;if(s.continuedAfterCutoff)continue;summary.stableSessions++;if(!s.results.length)continue;summary.stableResultSessions++;summary.stableResultRows+=s.results.length;
 let prev;const seenUuid=new Set(),seenTurn=new Set();let sumCost=0,sumMarginal=0;let positiveDelta=0,initResetDelta=0;
 for(const r of s.results){const cost=r.totalCostUsd??0;sumCost+=cost;summary.sumTotalCostUsd+=cost;if(r.marginalCostUsd!==undefined){sumMarginal+=r.marginalCostUsd;summary.sumMarginalCostUsd+=r.marginalCostUsd;summary.rowsWithMarginal++;}if(r.foreignResult)summary.foreignResultRows++;
 if(r.uuidKey){if(seenUuid.has(r.uuidKey))summary.duplicateResultUuidRows++;seenUuid.add(r.uuidKey);}if(r.turnKey){if(seenTurn.has(r.turnKey))summary.duplicateResultTurnRows++;seenTurn.add(r.turnKey);}
 const mc=Object.values(r.modelUsage).reduce((a,m)=>a+(m.costUSD??0),0);if(Math.abs(mc-cost)>1e-7){summary.modelCostMismatchRows++;summary.modelCostAbsoluteDiscrepancyUsd+=Math.abs(mc-cost);}
 positiveDelta+=!prev||cost<prev.totalCostUsd?cost:cost-prev.totalCostUsd;
 initResetDelta+=!prev||cost<prev.totalCostUsd||r.initCountBefore>prev.initCountBefore?cost:cost-prev.totalCostUsd;
 if(prev){if(cost<prev.totalCostUsd-1e-7){summary.counterDecreases++;if(r.initCountBefore===prev.initCountBefore)summary.decreasesWithoutNewInit++;}else if(cost>prev.totalCostUsd+1e-7&&r.initCountBefore===prev.initCountBefore)summary.increasesWithoutNewInit++;}
 const mo=(r.createdAt??s.createdAt??'unknown').slice(0,7);const b=byMonth[mo]??={resultRows:0,sumTotalCostUsd:0,sumMarginalCostUsd:0,rowsWithMarginal:0};b.resultRows++;b.sumTotalCostUsd+=cost;if(r.marginalCostUsd!==undefined){b.sumMarginalCostUsd+=r.marginalCostUsd;b.rowsWithMarginal++;}prev=r;
 }
 perSession.push({sessionKey:s.sessionKey,resultRows:s.results.length,sumTotalCostUsd:sumCost,sumMarginalCostUsd:sumMarginal,positiveDeltaUsd:positiveDelta,initResetDeltaUsd:initResetDelta,lastCostUsd:s.results.at(-1).totalCostUsd});
}
for(const session of sessions) for(const result of session.results) { delete result.uuidKey; delete result.turnKey; delete result.sdkMessageKey; }
const output={cutoff,summary,byMonth,perSession,rawSchemaCounters:{types,invalidJson},sessions};
writeFileSync('.lane/conductor-semantics.json',JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({cutoff,summary,byMonth,rawSchemaCounters:{types,invalidJson}},null,2));
