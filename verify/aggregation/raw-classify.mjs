import './safe-failures.mjs';
/** Final classification of every frozen reference session and every raw residual. */
import{readFileSync,writeFileSync}from'node:fs';import{homedir}from'node:os';import{join}from'node:path';
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const result=read('.lane/raw-oracle-results.json'),residual=read('.lane/raw-residuals.json'),desktop=read('.lane/raw-desktop-results.json'),legacy=read('.lane/raw-legacy-identity.json');
const snapshot=read(join(homedir(),'session-analytics-lanes/reference/snapshot-noindex-51ea561.json'));
const conclusions=new Map(result.matching.map(s=>[s.sessionKey,'verified-native-token-components-and-models']));
for(const s of residual.codex)if(s.classification==='oracle-identity-error-resolved')conclusions.set(s.sessionKey,'verified-native-token-components-and-models');
for(const s of residual.claude)if(s.classification==='oracle-componentwise-max-error-resolved')conclusions.set(s.sessionKey,'verified-native-token-components');
for(const s of desktop.sessions)if(s.tokenDelta===0)conclusions.set(s.sessionKey,'verified-desktop-input-and-output');
for(const s of legacy.rows)if(s.candidateCount===1&&s.tokenDelta===0)conclusions.set(s.referenceSessionKey,'verified-legacy-identity-and-token-components');
for(const s of result.lateActive)if(s.inReference)conclusions.set(s.sessionKey,'late-mutation-excluded');
const entries=snapshot.sessions.map(s=>({sessionKey:s.sessionKey,provider:s.provider,classification:conclusions.get(s.sessionKey)||(s.provider==='cursor'?'unsupported-cursor-raw-format':s.costBasis==='provider-reported'?'unsupported-conductor-recovered-raw-format':'unresolved'),inputTokens:s.tokens.inputTokens,outputTokens:s.tokens.outputTokens,referenceUsd:s.cost.totalUsd,month:(s.firstEventAt||s.createdAt||'unknown').slice(0,7)}));
const groups={};for(const s of entries){const k=s.classification;if(!groups[k])groups[k]={sessions:0,inputTokens:0,outputTokens:0,referenceUsd:0,months:[]};const g=groups[k];g.sessions++;g.inputTokens+=s.inputTokens;g.outputTokens+=s.outputTokens;g.referenceUsd+=s.referenceUsd;if(!g.months.includes(s.month))g.months.push(s.month);}
const summary={referenceSessions:entries.length,verifiedStableSessions:entries.filter(s=>s.classification.startsWith('verified-')).length,lateMutationExcluded:entries.filter(s=>s.classification==='late-mutation-excluded').length,unsupportedSourceSessions:entries.filter(s=>s.classification.startsWith('unsupported-')).length,unexplainedSessions:entries.filter(s=>s.classification==='unresolved').length,groups};
for(const row of result.mismatches){const proof=(row.provider==='codex'?residual.codex:residual.claude).find(x=>x.sessionKey===row.sessionKey);row.classification=proof?.classification||'unresolved';row.correctedDelta=proof?.delta||null;}
for(const row of result.missing){const match=legacy.rows.find(x=>x.rawSessionKey===row.sessionKey);row.classification=match?.candidateCount===1&&match.tokenDelta===0?'oracle-legacy-identity-error-resolved':'unresolved';if(match?.referenceSessionKey)row.referenceSessionKey=match.referenceSessionKey;}
result.reconciliation=summary;writeFileSync('.lane/raw-oracle-results.json',JSON.stringify(result,null,2));writeFileSync('.lane/raw-validation-summary.json',JSON.stringify({summary,sessions:entries},null,2));console.log(JSON.stringify(summary));
