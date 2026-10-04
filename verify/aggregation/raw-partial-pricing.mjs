import './safe-failures.mjs';
/** Independently reconcile explicit token-class coverage from raw request facts. */
import {readFileSync,writeFileSync}from'node:fs';import{homedir}from'node:os';import{join}from'node:path';
const facts=JSON.parse(readFileSync('.lane/raw-oracle-facts.json'));
const results=JSON.parse(readFileSync('.lane/snapshot-oracle-results.json'));
const mismatches=results.mismatches.filter(x=>x.field==='velocity.pricedTokens');
const snapshot=JSON.parse(readFileSync(join(homedir(),'session-analytics-lanes/reference/snapshot-noindex-51ea561.json')));
const reference=new Map(snapshot.sessions.map(s=>[s.sessionKey,s])),affected=new Map(mismatches.map(x=>[x.sessionKey,x]));const rows=[];
for(const s of facts.sessions){if(s.lateActive||!affected.has(s.sessionKey))continue;const ref=reference.get(s.sessionKey),models=new Set(ref.models.filter(m=>m.pricing.some(p=>p.assumptions.includes('anthropic-cache-1h-2x'))).map(m=>m.model));const req=s.requestEvidence.filter(r=>models.has(r.model)&&r.tokens.cacheWrite1hInputTokens>0);rows.push({sessionKey:s.sessionKey,requests:req.length,explicitClassTokens:req.reduce((a,r)=>a+r.tokens.inputTokens+r.tokens.outputTokens-r.tokens.cacheWrite1hInputTokens,0),cacheWrite1hTokens:req.reduce((a,r)=>a+r.tokens.cacheWrite1hInputTokens,0)});}
for(const s of JSON.parse(readFileSync('.lane/raw-desktop-results.json')).sessions)if(affected.has(s.sessionKey))rows.push({sessionKey:s.sessionKey,requests:s.affectedRequests,explicitClassTokens:s.explicitClassTokens,cacheWrite1hTokens:s.cacheWrite1hTokens});
for(const row of rows){const ref=affected.get(row.sessionKey);row.referenceDeficit=ref.expected-ref.actual;row.delta=row.explicitClassTokens-row.referenceDeficit;}
const result={sessions:rows.length,requests:rows.reduce((a,x)=>a+x.requests,0),explicitClassTokens:rows.reduce((a,x)=>a+x.explicitClassTokens,0),cacheWrite1hTokens:rows.reduce((a,x)=>a+x.cacheWrite1hTokens,0),unexplainedSessions:rows.filter(r=>r.delta!==0).length,rows};
writeFileSync('.lane/raw-partial-pricing.json',JSON.stringify(result,null,2));console.log(JSON.stringify(Object.fromEntries(Object.entries(result).filter(([k])=>k!=='rows'))));
