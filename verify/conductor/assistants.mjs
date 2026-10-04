// Independent oracle: no imports from src/. Raw bodies live only in local memory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from '../shared/sqlite.ts';

for (const event of ['uncaughtException','unhandledRejection']) process.on(event,()=>{console.error('Conductor assistant oracle failed; raw error suppressed.');process.exit(1);});

const home = os.homedir();
const snapshotPath = process.env.CONDUCTOR_REFERENCE ?? path.join(home, 'session-analytics-lanes/reference/snapshot-noindex-51ea561.json');
const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
const cutoff = Date.parse(snapshot.generatedAt);
const reference = snapshot.sessions.map(s => ({sessionKey:s.sessionKey, provider:s.provider,
  repositoryKey:crypto.createHash('sha256').update(String(s.repositoryId)).digest('hex').slice(0,12),
  createdAt:s.createdAt, lastEventAt:s.lastEventAt, updatedAt:s.updatedAt,
  source:s.evidence?.source ?? 'native', evidence:s.evidence, cost:s.cost, costComplete:s.costComplete,
  tokens:s.tokens, models:s.models, conductor:s.conductor,
  transcript:{files:s.transcript.files,status:s.transcript.status,completeness:s.transcript.completeness,snapshotWhileWorking:s.transcript.snapshotWhileWorking}}));
fs.mkdirSync('.lane', {recursive:true});
fs.writeFileSync('.lane/conductor-reference.json', JSON.stringify({generatedAt:snapshot.generatedAt,sessions:reference},null,2));
const byKey = new Map(reference.map(s => [s.sessionKey,s]));
const card = JSON.parse(fs.readFileSync('data/rate-cards.json','utf8')).models;
// Explicit historical family rates; no inferred fuzzy model matching.
for(const model of ['claude-opus-4-5','claude-opus-4-5-20251101','claude-opus-4-6-20260205','claude-opus-4-7','claude-opus-4-7-20260416']) card[model] = {...card['claude-opus-4-6']};
card['claude-haiku-4-5'] = {...card['claude-haiku-4-5-20251001']};
for(const model of ['claude-sonnet-4-5','claude-sonnet-4-5-20250929','claude-sonnet-4-6']) card[model] = {inputPerMillion:3, cacheReadPerMillion:0.3,cacheWrite5mPerMillion:3.75,cacheWrite1hPerMillion:6,outputPerMillion:15};
const n = v => typeof v==='number' && Number.isFinite(v) && v>=0 ? v : 0;
const blank = () => ({uncached:0,read:0,write:0,write5m:0,write1h:0,output:0});
const add = (a,b) => {for(const k of Object.keys(a)) a[k]+=b[k]??0;return a;};
const sumTokens = t => t.uncached+t.read+t.write+t.output;
function usage(u={}) {return {uncached:n(u.input_tokens),read:n(u.cache_read_input_tokens),write:n(u.cache_creation_input_tokens),write5m:n(u.cache_creation?.ephemeral_5m_input_tokens),write1h:n(u.cache_creation?.ephemeral_1h_input_tokens),output:n(u.output_tokens)};}
function price(model,t) {const r=card[model];if(!r)return null;const unspecified=Math.max(0,t.write-t.write5m-t.write1h);return (t.uncached*r.inputPerMillion+t.read*r.cacheReadPerMillion+(t.write5m+unspecified)*r.cacheWrite5mPerMillion+t.write1h*r.cacheWrite1hPerMillion+t.output*r.outputPerMillion)/1e6;}
function rawJson(s){try {const v=JSON.parse(s);return v&&typeof v==='object'&&!Array.isArray(v)?v:null;}catch{return null;}}
const hash = s => crypto.createHash('sha256').update(s).digest('hex').slice(0,12);
const db=new DatabaseSync(process.env.CONDUCTOR_DATABASE??path.join(home,'Library/Application Support/com.conductor.app/conductor.db'),{readOnly:true});
const sessions=db.prepare("select id,created_at,updated_at,claude_session_id from sessions where agent_type='claude'").all();
const messages=db.prepare('select content,full_message,created_at from session_messages where session_id=? order by created_at,id');
const output=[];const counters={sessions:sessions.length,rows:0,malformed:0,afterCutoff:0,streamedDuplicates:0,unknownModels:{},envelopeTypes:{}};
for(const s of sessions){
  const conductorKey=hash(s.id), providerKey=hash(`claude:${s.claude_session_id}`);
  const key=byKey.has(conductorKey)?conductorKey:byKey.has(providerKey)?providerKey:conductorKey;
  const requests=new Map();let maxAt=Date.parse(s.created_at), resultCount=0, assistantRows=0, missingMessageIds=0, resultSum=0, marginalSum=0, marginalCount=0;const resultIds=new Set();
  for(const row of messages.iterate(s.id)){
    counters.rows++;const at=Date.parse(row.created_at);if(at>maxAt)maxAt=at;
    const envelope=rawJson(row.full_message)??rawJson(row.content);if(!envelope){counters.malformed++;continue;}
    if(at>cutoff)continue;
    const kind=['assistant','user','system','result','stream_event'].includes(envelope.type)?envelope.type:'other';counters.envelopeTypes[kind]=(counters.envelopeTypes[kind]??0)+1;
    if(envelope.type==='result'){
      if(envelope.uuid&&resultIds.has(envelope.uuid))continue;if(envelope.uuid)resultIds.add(envelope.uuid);
      resultCount++;resultSum+=n(envelope.total_cost_usd);if(typeof envelope.conductor_sdk_metadata?.marginalCostUsd==='number'){marginalCount++;marginalSum+=n(envelope.conductor_sdk_metadata.marginalCostUsd);}continue;
    }
    if(envelope.type!=='assistant'||!envelope.message?.usage)continue;
    const msg=envelope.message;assistantRows++;if(typeof msg.id!=='string'){missingMessageIds++;continue;}
    const tokens=usage(msg.usage);const old=requests.get(msg.id);
    if(old){counters.streamedDuplicates++;for(const k of Object.keys(tokens))old.tokens[k]=Math.max(old.tokens[k],tokens[k]);}
    else requests.set(msg.id,{model:/^claude-[a-z0-9.-]+$/.test(msg.model??'')?msg.model:'unknown',tokens,isChild:!!envelope.parent_tool_use_id});
  }
  if(maxAt>cutoff||Date.parse(s.updated_at)>cutoff){counters.afterCutoff++;continue;}
  const totals=blank(),models=new Map();let usd=0,unpricedTokens=0,childUsd=0,childCalls=0;
  for(const req of requests.values()){
    add(totals,req.tokens);const cost=price(req.model,req.tokens);
    if(cost===null){unpricedTokens+=sumTokens(req.tokens);counters.unknownModels[req.model]=(counters.unknownModels[req.model]??0)+1;}else {usd+=cost;if(req.isChild)childUsd+=cost;}
    if(req.isChild)childCalls++;
    if(!models.has(req.model))models.set(req.model,{model:req.model,calls:0,tokens:blank(),usd:0});const m=models.get(req.model);m.calls++;add(m.tokens,req.tokens);m.usd+=cost??0;
  }
  const ref=byKey.get(key);output.push({sessionKey:key,conductorKey,month:s.created_at.slice(0,7),lastActivityAt:Number.isFinite(maxAt)?new Date(maxAt).toISOString():null,referenceSource:ref?.source??'missing',repositoryKey:ref?.repositoryKey??null,referenceUsd:ref?.cost.totalUsd??0,referenceTokens:ref?(ref.tokens.inputTokens+ref.tokens.outputTokens):0,assistantRows,assistantCalls:requests.size,missingMessageIds,childCalls,childUsd,tokens:totals,totalTokens:sumTokens(totals),usd,unpricedTokens,resultCount,resultSum,marginalSum,marginalCount,models:[...models.values()],deltaUsd:usd-(ref?.cost.totalUsd??0),deltaTokens:sumTokens(totals)-(ref?(ref.tokens.inputTokens+ref.tokens.outputTokens):0)});
}
db.close();
const months={};for(const s of output){const k=s.month;const m=months[k]??={sessions:0,recovered:0,referenceUsd:0,assistantUsd:0,referenceTokens:0,assistantTokens:0};m.sessions++;if(s.referenceSource==='conductor-result'){m.recovered++;m.referenceUsd+=s.referenceUsd;m.assistantUsd+=s.usd;m.referenceTokens+=s.referenceTokens;m.assistantTokens+=s.totalTokens;}}
fs.writeFileSync('.lane/conductor-assistants.json',JSON.stringify({cutoff:snapshot.generatedAt,counters,months,sessions:output},null,2));
console.log(JSON.stringify({counters,months}));
