/** Independent arithmetic oracle: no production imports. Only emits allowlisted data. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
const snapshotPath = process.argv[2] || path.join(os.homedir(), 'session-analytics-lanes/reference/snapshot-noindex-51ea561.json');
const cachePath = process.argv[3] || process.env.PRICING_ORACLE_CACHE_DIR || (process.env.SESSION_ANALYTICS_DATA_DIR && path.join(process.env.SESSION_ANALYTICS_DATA_DIR, 'pricing')) || path.join(os.homedir(), 'Library/Application Support/session-analytics/pricing');
const outputPath = process.argv[4] || '.lane/pricing-snapshot-oracle.json';
const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
const card = JSON.parse(fs.readFileSync('data/rate-cards.json', 'utf8'));
const official = JSON.parse(fs.readFileSync('verify/pricing/official-rates.json', 'utf8'));
function historical(rate, model, timestamp) {
 const day = typeof timestamp === 'string' ? timestamp.slice(0,10) : null;
 const h = day && official.history.find(h => h.model === model && h.input !== undefined && (!h.from || day >= h.from) && day < h.untilExclusive);
 return h ? {...rate,inputPerMillion:h.input,cachedInputPerMillion:h.cacheRead,outputPerMillion:h.output} : rate;
}
function migrateFeed(rate, model) {
 if(['gpt-5.3-codex','gpt-5.4','gpt-5.4-mini','gpt-5.5'].includes(model)&&rate.cacheWriteObservable===false&&rate.cacheWriteMultiplier===1.25&&rate.assumptions?.includes('codex-cache-write-upper-1.25x')&&rate.cacheWrite5mPerMillion===undefined&&rate.cacheWrite1hPerMillion===undefined)return {...rate,cacheWriteMultiplier:1};
 return rate;
}
const tokenFields = ['inputTokens','uncachedInputTokens','cachedInputTokens','cacheWriteInputTokens','cacheWrite5mInputTokens','cacheWrite1hInputTokens','outputTokens','reasoningOutputTokens','nonReasoningOutputTokens'];
const dollarFields = ['inputUsd','cachedInputUsd','cacheWriteUsd','outputUsd','totalUsd','upperEstimateUsd'];
const sum = (rows, field) => rows.reduce((v,row) => v + (row[field] || 0), 0);
const close = (a,b) => Math.abs(a-b) <= 1e-7 + Math.max(Math.abs(a),Math.abs(b))*1e-11;
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0,16);
const modelSafe = value => typeof value === 'string' && (value === '<unknown>' || value === '<synthetic>' || /^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,127}$/.test(value)) ? value : '<unknown>';
const tables = [];
for (const name of fs.readdirSync(cachePath)) {
 if (!/^(?:models\.dev|litellm|reviewed)-/.test(name)) continue;
 try {
  const env = JSON.parse(fs.readFileSync(path.join(cachePath,name),'utf8')); const s=env.snapshot;
  if (s?.source && s.fetchedAt <= snapshot.generatedAt) tables.push({...s,models:s.card?.models || s.models || JSON.parse(fs.readFileSync(path.join(cachePath,`rates-${s.modelsSha256}.json`),'utf8'))});
 } catch { /* Missing/damaged evidence remains unavailable; no local error text. */ }
}
const rateEvidence = [];
function independentRate(model, timestamp) {
 if(model==='gpt-5.3-codex-spark')return null;
 // Exact IDs suffice for this snapshot. Alias behavior is covered separately with synthetic cases.
 const reviewed=card.models[model];
 if (reviewed && card.reviewedOverrides.includes(model)) return {rate:historical(reviewed,model,timestamp),source:'reviewed',date:`${card.effectiveDate}T00:00:00.000Z`,kind:'reviewed'};
 const ranked=[];
 for (const source of ['models.dev','litellm']) {
  const entries=tables.filter(s=>s.source===source && s.models[model]).sort((a,b)=>a.fetchedAt.localeCompare(b.fetchedAt));
  if (!entries.length) continue;
  const prior=entries.filter(s=>s.fetchedAt<=timestamp); const chosen=prior.at(-1) || entries[0];
  ranked.push({rate:migrateFeed(chosen.models[model],model),source,date:chosen.fetchedAt,kind:'api',prior:prior.length>0});
 }
 const result=ranked.find(r=>r.prior) || ranked[0];
 if (result) return result;
 return reviewed ? {rate:reviewed,source:'reviewed',date:`${card.effectiveDate}T00:00:00.000Z`,kind:'fallback'} : null;
}
function calculate(model, resolved, inputMultiplier=1, outputMultiplier=1, ttlUpper=false) {
 if (!resolved) return {inputUsd:0,cachedInputUsd:0,cacheWriteUsd:0,outputUsd:0,totalUsd:0,upperEstimateUsd:0,pricedTokens:0,eligibleTokens:model.inputTokens+model.outputTokens};
 const r=resolved.rate, input=r.inputPerMillion*inputMultiplier, output=r.outputPerMillion*outputMultiplier;
 const read=(r.cacheReadPerMillion ?? r.cachedInputPerMillion ?? r.inputPerMillion)*inputMultiplier;
 const write5=(r.cacheWrite5mPerMillion ?? r.inputPerMillion*(r.cacheWriteMultiplier ?? 1))*inputMultiplier;
 const write1=(r.cacheWrite1hPerMillion ?? r.cacheWrite5mPerMillion ?? r.inputPerMillion*(r.cacheWriteMultiplier ?? 1))*inputMultiplier;
 const unsplit=Math.max(0,model.cacheWriteInputTokens-model.cacheWrite5mInputTokens-model.cacheWrite1hInputTokens);
 const inputUsd=model.uncachedInputTokens*input/1e6;
 const cachedInputUsd=model.cachedInputTokens*read/1e6;
 const cacheWriteUsd=((model.cacheWrite5mInputTokens+unsplit)*write5+model.cacheWrite1hInputTokens*write1)/1e6;
 const outputUsd=model.outputTokens*output/1e6;
 const totalUsd=inputUsd+cachedInputUsd+cacheWriteUsd+outputUsd;
 const upperEstimateUsd=totalUsd+(r.cacheWriteObservable===false?model.uncachedInputTokens*Math.max(0,write5-input)/1e6:0)
   +(ttlUpper?unsplit*Math.max(0,write1-write5)/1e6:0);
 let pricedTokens=model.uncachedInputTokens+model.outputTokens;
 if (r.cacheReadPerMillion != null || r.cachedInputPerMillion != null) pricedTokens+=model.cachedInputTokens;
 if (r.cacheWrite5mPerMillion != null) pricedTokens+=model.cacheWrite5mInputTokens;
 if (r.cacheWrite1hPerMillion != null && !(r.assumptions||[]).includes('anthropic-cache-1h-2x')) pricedTokens+=model.cacheWrite1hInputTokens;
 return {inputUsd,cachedInputUsd,cacheWriteUsd,outputUsd,totalUsd,upperEstimateUsd,pricedTokens,eligibleTokens:model.inputTokens+model.outputTokens};
}
const checks=[], mismatches=[], requestPremiums=[], modelRows=[], providerReportedAllocationDifferences=[], unallocatedModelTokens=[], rawRequestPricingRequired=[];
function check(scope,key,field,actual,expected) {
 const integerField=field.endsWith('Tokens') || field==='calls';
 const good=typeof actual==='number' && typeof expected==='number' && !integerField ? close(actual,expected) : actual===expected;
 checks.push({scope,field,good}); if (!good) mismatches.push({scope,key,field,actual,expected,delta:typeof actual==='number'&&typeof expected==='number'?actual-expected:null});
}
const sessionRows=[];
for (const s of snapshot.sessions) {
 const key=s.sessionKey, repository=hash(s.repositoryId), month=(s.firstEventAt || s.createdAt || '').slice(0,7) || 'undated';
 const afterReference=[s.lastEventAt,s.updatedAt].some(t=>typeof t==='string'&&t>snapshot.generatedAt);
 const row={sessionKey:key,repository,month,provider:s.provider,basis:s.costBasis,afterReference,tokens:Object.fromEntries(tokenFields.map(f=>[f,s.tokens[f]])),snapshotUsd:s.cost.totalUsd,snapshotUpperUsd:s.cost.upperEstimateUsd,baseOracleUsd:0,baseOracleUpperUsd:0,knownPremiumPossible:false,pricedTokens:0,eligibleTokens:0};
 for (const f of tokenFields) {
  const allocated=sum(s.models,f);
  if (s.costBasis==='provider-reported' && !close(s.tokens[f],allocated)) unallocatedModelTokens.push({sessionKey:key,month,provider:s.provider,field:f,sessionTokens:s.tokens[f],modelAllocatedTokens:allocated});
  else check('session-token-model-sum',key,f,s.tokens[f],allocated);
 }
 for (const m of s.models) {
  const model=modelSafe(m.model), resolved=independentRate(model,s.firstEventAt || s.createdAt || snapshot.generatedAt);
  const api=s.costBasis==='api-list-price-equivalent';
  // Adapter recovery explicitly bounds unknown TTLs; native per-request output
  // retains its existing tariff/coverage contract. Raw request gates certify it.
  const ttlUpper=!!s.evidence;
  const oracle=calculate(m,resolved,1,1,ttlUpper), rule=resolved?.rate.longContext;
  const premiumPossible=!!rule && (s.metrics.maxInputTokensPerCall > rule.thresholdInputTokens);
  const start=s.firstEventAt || s.createdAt, end=s.lastEventAt || start;
  const dates=new Set([start,end]);
  for(const interval of official.history.filter(h=>h.model===model&&h.input!==undefined)) {
   for(const day of [interval.from,interval.untilExclusive]) if(day&&`${day}T00:00:00.000Z`>start&&`${day}T00:00:00.000Z`<=end)dates.add(`${day}T00:00:00.000Z`);
  }
  const rateVariants=[...new Map([...dates].map(at=>independentRate(model,at)).map(r=>[JSON.stringify(r?.rate??null),r])).values()];
  const multipleTariffs=rateVariants.length>1;
  const baseVariants=rateVariants.map(r=>calculate(m,r,1,1,ttlUpper));
  const upperVariants=rateVariants.map(r=>premiumPossible&&r?.rate.longContext?calculate(m,r,r.rate.longContext.inputMultiplier,r.rate.longContext.outputMultiplier,ttlUpper):calculate(m,r,1,1,ttlUpper));
  if(api&&(multipleTariffs||premiumPossible))rawRequestPricingRequired.push({sessionKey:key,model,multipleTariffs,premiumPossible});
  const item={sessionKey:key,repository,month,provider:s.provider,basis:s.costBasis,model,tokens:Object.fromEntries(tokenFields.map(f=>[f,m[f]])),calls:m.calls,source:resolved?.source || null,snapshotDate:resolved?.date || null,snapshotUsd:m.totalUsd,snapshotUpperUsd:m.upperEstimateUsd,baseOracleUsd:oracle.totalUsd,baseOracleUpperUsd:oracle.upperEstimateUsd,baseResidualUsd:m.totalUsd-oracle.totalUsd,maxContextOracleUsd:Math.max(...upperVariants.map(r=>r.totalUsd)),premiumPossible,multipleTariffs,expectedPricedTokens:oracle.pricedTokens,expectedEligibleTokens:oracle.eligibleTokens,snapshotPricedTokens:m.pricingCoverage?.pricedTokens ?? null};
  modelRows.push(item);
  if (!api) continue;
  row.baseOracleUsd+=oracle.totalUsd; row.baseOracleUpperUsd+=oracle.upperEstimateUsd; row.pricedTokens+=oracle.pricedTokens; row.eligibleTokens+=oracle.eligibleTokens; row.knownPremiumPossible ||= premiumPossible;
  for (const f of dollarFields) {
   if (!premiumPossible&&!multipleTariffs) check('api-model-formula',`${key}:${model}`,f,m[f],oracle[f]);
   else {
    const inBounds=m[f]>=Math.min(...baseVariants.map(r=>r[f]))-1e-7 && m[f]<=Math.max(...upperVariants.map(r=>r[f]))+1e-7;
    check(multipleTariffs?'api-model-tariff-bounds':'api-model-context-bounds',`${key}:${model}`,f,inBounds,true);
   }
  }
  // Whatever fraction gets the context premium, Codex upper cache-write increment is 25% of priced uncached input.
  if (resolved?.rate.cacheWriteObservable===false) check('codex-upper-formula',`${key}:${model}`,'upperEstimateUsd',m.upperEstimateUsd,m.totalUsd+m.inputUsd*Math.max(0,(resolved.rate.cacheWriteMultiplier??1)-1));
  check('api-model-coverage',`${key}:${model}`,'eligibleTokens',m.pricingCoverage?.eligibleTokens,oracle.eligibleTokens);
  check('api-model-coverage',`${key}:${model}`,'pricedTokens',m.pricingCoverage?.pricedTokens,oracle.pricedTokens);
  if (premiumPossible && !close(m.totalUsd,oracle.totalUsd)) requestPremiums.push(item);
  if (resolved) for (const evidence of m.pricing||[]) {
   check('rate-provenance',`${key}:${model}`,'source',evidence.source,resolved.source);
   check('rate-provenance',`${key}:${model}`,'rateModel',evidence.rateModel,model);
  }
 }
 if (s.costBasis==='api-list-price-equivalent') {
  for (const f of dollarFields) check('session-dollar-model-sum',key,f,s.cost[f],sum(s.models,f));
  check('session-coverage',key,'pricedTokenCoverage',s.pricedTokenCoverage,row.eligibleTokens?row.pricedTokens/row.eligibleTokens:null);
  const classes=s.tokens.uncachedInputTokens+s.tokens.cachedInputTokens+s.tokens.cacheWriteInputTokens;
  check('session-token-class-sum',key,'inputTokens',s.tokens.inputTokens,classes);
  check('session-token-class-sum',key,'outputClassificationBounded',s.tokens.nonReasoningOutputTokens+s.tokens.reasoningOutputTokens<=s.tokens.outputTokens,true);
  const execution=s.costByExecution;
  if (execution) check('session-execution-value',key,'totalUsd',s.cost.totalUsd,execution.topLevelUsd+execution.subagentUsd+execution.unknownUsd);
 } else if (s.costBasis==='provider-reported') {
  const difference=s.cost.totalUsd-sum(s.models,'totalUsd');
  if (!close(difference,0)) providerReportedAllocationDifferences.push({sessionKey:key,month,provider:s.provider,reportedUsd:s.cost.totalUsd,modelAllocatedUsd:sum(s.models,'totalUsd'),unallocatedUsd:difference});
 }
 sessionRows.push(row);
}
function aggregate(rows, keyFn) {
 const groups=new Map();
 for (const row of rows) {
  const key=keyFn(row); if(!groups.has(key))groups.set(key,{key,sessions:0,inputTokens:0,outputTokens:0,snapshotUsd:0,snapshotUpperUsd:0,baseOracleUsd:0,baseOracleUpperUsd:0,pricedTokens:0,eligibleTokens:0,premiumPossibleSessions:0});
  const g=groups.get(key); g.sessions++; g.inputTokens+=row.tokens.inputTokens; g.outputTokens+=row.tokens.outputTokens;
  for(const f of ['snapshotUsd','snapshotUpperUsd','baseOracleUsd','baseOracleUpperUsd','pricedTokens','eligibleTokens'])g[f]+=row[f]||0;
  if (row.knownPremiumPossible) g.premiumPossibleSessions++;
 }
 return [...groups.values()].sort((a,b)=>a.key.localeCompare(b.key));
}
const allCosts=snapshot.sessions.map(s=>s.cost), apiRows=sessionRows.filter(s=>s.basis==='api-list-price-equivalent'), reportedRows=sessionRows.filter(s=>s.basis==='provider-reported');
check('machine-summary','all','estimatedSpendUsd',snapshot.summary.estimatedSpendUsd,sum(allCosts,'totalUsd'));
check('machine-summary','all','apiEquivalentSpendUsd',snapshot.summary.apiEquivalentSpendUsd,sum(apiRows,'snapshotUsd'));
check('machine-summary','all','providerReportedSpendUsd',snapshot.summary.providerReportedSpendUsd,sum(reportedRows,'snapshotUsd'));
check('machine-summary','all','estimatedUpperSpendUsd',snapshot.summary.estimatedUpperSpendUsd,sum(allCosts,'upperEstimateUsd'));
check('machine-summary','all','totalInputTokens',snapshot.summary.totalInputTokens,sum(snapshot.sessions.map(s=>s.tokens),'inputTokens'));
check('machine-summary','all','outputTokens',snapshot.summary.outputTokens,sum(snapshot.sessions.map(s=>s.tokens),'outputTokens'));
const coverageKeys=new Set(snapshot.sessions.filter(s=>s.pricedTokenCoverage!==null).map(s=>s.sessionKey));
const coverageRows=sessionRows.filter(row=>coverageKeys.has(row.sessionKey));
const priced=sum(apiRows,'pricedTokens'),eligible=coverageRows.reduce((n,row)=>n+row.tokens.inputTokens+row.tokens.outputTokens,0);
check('machine-summary','all','pricedTokenCoverage',snapshot.summary.pricedTokenCoverage,eligible?priced/eligible:null);
for (const repository of snapshot.repositories) {
 const rawId=repository.repository.id;
 const rows=sessionRows.filter(s=>s.repository===hash(rawId));
 if (!rows.length) continue;
 check('repository-summary',hash(rawId),'estimatedSpendUsd',repository.summary.estimatedSpendUsd,sum(rows,'snapshotUsd'));
 check('repository-summary',hash(rawId),'estimatedUpperSpendUsd',repository.summary.estimatedUpperSpendUsd,sum(rows,'snapshotUpperUsd'));
}
for (const total of snapshot.spendByModel) {
 const rows=snapshot.sessions.flatMap(s=>s.models.filter(m=>m.model===total.model));
 for (const f of [...tokenFields,...dollarFields,'calls']) check('machine-model-sum',modelSafe(total.model),f,total[f],sum(rows,f));
}
const dayMap=new Map();
for (const s of snapshot.sessions) for (const [day,value] of Object.entries(s.spendByDay)) dayMap.set(day,(dayMap.get(day)||0)+value);
for (const d of snapshot.spendByDay) check('machine-day-sum',d.name,'value',d.value,dayMap.get(d.name)||0);
const checkCounts={}; for(const c of checks){const b=checkCounts[c.scope] ||= {checked:0,passed:0,failed:0};b.checked++; b[c.good?'passed':'failed']++;}
const output={oracleVersion:1,generatedAt:snapshot.generatedAt,method:'Independent scalar arithmetic from public token fields, immutable rate input records, and published metric contracts. No production imports. Aggregate costs with possible context premium are bounded, not spuriously recomputed as exact request costs.',limitations:['Snapshot token fields are parser outputs, not independently verified physical counters; separate raw oracles establish those.','Long-context request distribution cannot be reconstructed exactly from session/model aggregates; residuals below require raw request joins.','Current cache contains one observation per source; historical rates before these dates remain labeled oldest.','Official rate verification is recorded separately.','This frozen-snapshot arithmetic pass does not reopen histories for later activity; continued-session exclusions belong to the raw oracles.'],summary:{sessions:sessionRows.length,apiSessions:apiRows.length,reportedSessions:reportedRows.length,unavailableSessions:sessionRows.filter(s=>s.basis==='unavailable').length,apiUsd:sum(apiRows,'snapshotUsd'),reportedUsd:sum(reportedRows,'snapshotUsd'),totalUsd:sum(sessionRows,'snapshotUsd'),apiBaseOracleUsd:sum(apiRows,'baseOracleUsd'),apiBaseResidualUsd:sum(apiRows,'snapshotUsd')-sum(apiRows,'baseOracleUsd'),pricedTokens:priced,eligibleTokens:eligible,coverage:eligible?priced/eligible:null,requestPremiumRows:requestPremiums.length,excludedContinuedSessions:sessionRows.filter(s=>s.afterReference).length},checkCounts,mismatches,requestPremiums,providerReportedAllocationDifferences,unallocatedModelTokens,byMonth:aggregate(sessionRows,s=>`${s.month}:${s.basis}`),byProvider:aggregate(sessionRows,s=>`${s.provider}:${s.basis}`),byRepository:aggregate(sessionRows,s=>`${s.repository}:${s.basis}`),byModel:aggregate(modelRows.map(r=>({...r,pricedTokens:r.expectedPricedTokens,eligibleTokens:r.expectedEligibleTokens})),s=>`${s.model}:${s.basis}`),sessions:sessionRows,models:modelRows};
output.rawRequestPricingRequired=rawRequestPricingRequired;
output.limitations.push('Session aggregates spanning a reviewed tariff boundary use bounds only; exact component and request totals require the companion raw-request oracle. Adapter unknown-TTL upper bounds retain the unobserved write remainder separately.');
fs.mkdirSync(path.dirname(outputPath),{recursive:true}); fs.writeFileSync(outputPath,JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({summary:output.summary,checkCounts,mismatches:mismatches.slice(0,15)},null,2));
