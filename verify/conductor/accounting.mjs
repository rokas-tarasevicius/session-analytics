process.on('uncaughtException', () => { console.error('Oracle failed; private details suppressed.'); process.exit(1); });
process.on('unhandledRejection', () => { console.error('Oracle failed; private details suppressed.'); process.exit(1); });
// Second-phase comparison over independently projected, content-free oracle data.
import {readFileSync,writeFileSync} from 'node:fs';
const raw=JSON.parse(readFileSync('.lane/conductor-semantics.json','utf8'));
const ref=JSON.parse(readFileSync('.lane/conductor-reference.json','utf8'));
const refs=new Map(ref.sessions.map(s=>[s.sessionKey,s]));
const eq=(a,b)=>Math.abs(a-b)<1e-7;
const summary={};const months={};const sessions=[];const examples={};
function add(k,s,r,v){const b=summary[k]??={sessions:0,referenceUsd:0,sumTotalUsd:0,maxTotalUsd:0,marginalUsd:0,candidateUsd:0,referenceTokens:0};b.sessions++;b.referenceUsd+=r.cost.totalUsd;b.sumTotalUsd+=v.sum;b.maxTotalUsd+=v.max;b.marginalUsd+=v.marginal;b.candidateUsd+=v.candidate;b.referenceTokens+=r.tokens.inputTokens+r.tokens.outputTokens;}
for(const s of raw.sessions){if(s.continuedAfterCutoff)continue;const r=refs.get(s.sessionKey)??refs.get(s.providerSessionKey);if(!r||r.source!=='conductor-result')continue;
 const nonzero=s.results.filter(x=>x.totalCostUsd>0);const sum=s.results.reduce((a,x)=>a+(x.totalCostUsd??0),0),max=Math.max(0,...s.results.map(x=>x.totalCostUsd??0)),marginal=s.results.reduce((a,x)=>a+(x.marginalCostUsd??0),0);
 const missing=nonzero.filter(x=>x.marginalCostUsd===undefined).length;const explicitComplete=nonzero.length>0&&!missing;
 const versions=s.results.map(x=>s.inits[Math.max(0,x.initCountBefore-1)]?.version);
 const old=versions.every(v=>/^2\.1\.\d+$/.test(v??'')&&Number(v.split('.')[2])<277);
 const candidate=max;const v={sum,max,marginal,candidate};
 const classification=!nonzero.length?'zero-cost-receipts':explicitComplete?'explicit-marginal-complete':old?'old-without-complete-marginal':'mixed-or-unknown-marginal';
 add('all',s,r,v);add(classification,s,r,v);
 const at=r.createdAt.slice(0,7);const mo=months[at]??={sessions:0,referenceUsd:0,sumTotalUsd:0,maxTotalUsd:0,marginalUsd:0,explicitCompleteSessions:0,explicitCompleteReferenceUsd:0,explicitCompleteOracleUsd:0};mo.sessions++;mo.referenceUsd+=r.cost.totalUsd;mo.sumTotalUsd+=sum;mo.maxTotalUsd+=max;mo.marginalUsd+=marginal;if(explicitComplete){mo.explicitCompleteSessions++;mo.explicitCompleteReferenceUsd+=r.cost.totalUsd;mo.explicitCompleteOracleUsd+=marginal;}
 const tokenVectors=s.results.map(x=>Object.values(x.modelUsage).reduce((a,u)=>({inputTokens:a.inputTokens+(u.inputTokens??0)+(u.cacheReadInputTokens??0)+(u.cacheCreationInputTokens??0),outputTokens:a.outputTokens+(u.outputTokens??0),observed:a.observed||u.inputTokens!==undefined||u.outputTokens!==undefined}),{inputTokens:0,outputTokens:0,observed:false}));
 const tokenLowerBound={inputTokens:Math.max(0,...tokenVectors.map(x=>x.inputTokens)),outputTokens:Math.max(0,...tokenVectors.map(x=>x.outputTokens))};
 const detail={sessionKey:s.sessionKey,referenceSessionKey:r.sessionKey,createdAt:r.createdAt,classification,month:at,accounting:explicitComplete?'suspected-ledger-comparison':'lower-bound',correctedCostUsd:null,costBounds:{minUsd:max,maxUsd:sum},marginalLedgerUsd:explicitComplete?marginal:null,correctedTokens:null,tokenLowerBound,tokenEvidence:tokenVectors.some(x=>x.observed)?'cumulative-model-counters':'unavailable',residualExplanationTags:[old?'init-is-query-not-process':'session-maximum-discards-reset-intervals',explicitComplete?'all-nonzero-receipts-have-marginal-ledger-needs-independent-check':'marginal-missing',tokenVectors.every(x=>x.observed)?'model-counters-present':'model-counters-sparse'],resultRecords:s.results.length,missingMarginalRecords:missing,oldVersions:old,versions:[...new Set(versions)],referenceUsd:r.cost.totalUsd,sumTotalUsd:sum,maxTotalUsd:max,marginalUsd:marginal,candidateLowerBoundUsd:candidate,referenceInputTokens:r.tokens.inputTokens,referenceOutputTokens:r.tokens.outputTokens};sessions.push(detail);
 if((examples[classification]??=[]).length<3)examples[classification].push(detail);
}
const metadataRelations={equalsCurrent:{rows:0,usd:0},equalsDelta:{rows:0,usd:0},other:{rows:0,usd:0},upwardReset:{rows:0,usd:0,missedByPositiveDeltaUsd:0}};
for(const s of raw.sessions.filter(x=>!x.continuedAfterCutoff)){let prev;for(const r of s.results){if(r.marginalCostUsd!==undefined){const curr=r.totalCostUsd??0,m=r.marginalCostUsd;const bucket=eq(m,curr)?'equalsCurrent':eq(m,curr-(prev?.totalCostUsd??0))?'equalsDelta':'other';metadataRelations[bucket].rows++;metadataRelations[bucket].usd+=m;if(prev&&eq(m,curr)&&curr>prev.totalCostUsd&&prev.totalCostUsd>0){metadataRelations.upwardReset.rows++;metadataRelations.upwardReset.usd+=m;metadataRelations.upwardReset.missedByPositiveDeltaUsd+=prev.totalCostUsd;}}prev=r;}}
const out={cutoff:raw.cutoff,summary,months,metadataRelations,examples,sessions};writeFileSync('.lane/conductor-accounting.json',JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify({summary,months,metadataRelations},null,2));
