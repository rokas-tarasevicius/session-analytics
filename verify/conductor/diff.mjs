// Rejoins the content-free oracle after checking both documented identity families.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from '../shared/sqlite.ts';
for(const event of ['uncaughtException','unhandledRejection'])process.on(event,()=>{console.error('Conductor difference oracle failed; raw error suppressed.');process.exit(1);});
const hash=s=>crypto.createHash('sha256').update(s).digest('hex').slice(0,12);
const a=JSON.parse(fs.readFileSync('.lane/conductor-assistants.json','utf8'));
const ref=JSON.parse(fs.readFileSync('.lane/conductor-reference.json','utf8'));
const byKey=new Map(ref.sessions.map(s=>[s.sessionKey,s]));
const db=new DatabaseSync(process.env.CONDUCTOR_DATABASE??path.join(os.homedir(),'Library/Application Support/com.conductor.app/conductor.db'),{readOnly:true});
const rows=new Map(db.prepare("select id,claude_session_id from sessions where agent_type='claude'").all().map(s=>[hash(s.id),hash(`claude:${s.claude_session_id}`)]));db.close();
for(const s of a.sessions){s.conductorKey??=s.sessionKey;const r=byKey.get(s.conductorKey)??byKey.get(rows.get(s.conductorKey));s.sessionKey=r?.sessionKey??s.conductorKey;s.referenceSource=r?.source??'missing';s.referenceUsd=r?.cost.totalUsd??0;s.referenceTokens=r?r.tokens.inputTokens+r.tokens.outputTokens:0;s.repositoryKey=r?.repositoryKey??null;s.deltaUsd=s.usd-s.referenceUsd;s.deltaTokens=s.totalTokens-s.referenceTokens;
  s.assistantComparisonStatus=s.missingMessageIds>0?'partial-request-identities':s.assistantCalls>0?'identified-visible-requests':'no-identified-usage';
  s.deltaIsConfirmedAccountingError=false;
  s.comparisonLimits=s.missingMessageIds>0?['missing-api-request-id','stored-stream-output-is-not-final','api-estimate-vs-sdk-reported-basis']:['visible-requests-need-not-exhaust-sdk-billing','api-estimate-vs-sdk-reported-basis'];
}
const fields=['referenceUsd','referenceTokens','usd','totalTokens','deltaUsd','deltaTokens','resultCount','resultSum','marginalCount','marginalSum','assistantCalls','childCalls','childUsd','unpricedTokens'];
function summarize(rows){const out={sessions:rows.length};for(const f of fields)out[f]=rows.reduce((n,s)=>n+s[f],0);return out;}
const recovered=a.sessions.filter(s=>s.referenceSource==='conductor-result');
const months={};for(const m of [...new Set(a.sessions.map(s=>s.month))].sort()){const all=a.sessions.filter(s=>s.month===m);months[m]={claudeSessions:all.length,recovered:summarize(all.filter(s=>s.referenceSource==='conductor-result')),native:summarize(all.filter(s=>s.referenceSource==='native')),missing:summarize(all.filter(s=>s.referenceSource==='missing'))};}
const modelDiffs={};for(const s of recovered){const r=byKey.get(s.sessionKey);for(const m of new Set([...s.models.map(x=>x.model),...r.models.map(x=>x.model)])){const x=s.models.find(x=>x.model===m),y=r.models.find(x=>x.model===m);const v=modelDiffs[m]??={sessions:0,assistantUsd:0,referenceUsd:0,assistantTokens:0,referenceTokens:0};v.sessions++;v.assistantUsd+=x?.usd??0;v.referenceUsd+=y?.totalUsd??0;v.assistantTokens+=x?x.tokens.uncached+x.tokens.read+x.tokens.write+x.tokens.output:0;v.referenceTokens+=y?y.inputTokens+y.outputTokens:0;}}
const repositories={};for(const s of recovered){const r=repositories[s.repositoryKey]??={sessions:0,assistantUsd:0,referenceUsd:0,assistantTokens:0,referenceTokens:0};r.sessions++;r.assistantUsd+=s.usd;r.referenceUsd+=s.referenceUsd;r.assistantTokens+=s.totalTokens;r.referenceTokens+=s.referenceTokens;}
a.months=months;fs.writeFileSync('.lane/conductor-assistants.json',JSON.stringify(a,null,2));
const result={cutoff:a.cutoff,counters:a.counters,recovered:summarize(recovered),native:summarize(a.sessions.filter(s=>s.referenceSource==='native')),missing:summarize(a.sessions.filter(s=>s.referenceSource==='missing')),months,modelDiffs,repositories};
fs.writeFileSync('.lane/conductor-diff.json',JSON.stringify(result,null,2));console.log(JSON.stringify({recovered:result.recovered,native:result.native,missing:result.missing,months}));
