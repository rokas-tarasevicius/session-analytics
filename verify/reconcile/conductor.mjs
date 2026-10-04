// Reconcile the content-free projection produced by conductor-evidence.mjs.
// Original independent implementation: .lane/conductor-initial-oracle.mjs.
// Its decrease-implies-reset assumption was rejected after raw/schema verification.
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

try {
const evidence=JSON.parse(readFileSync('.lane/conductor-evidence.json','utf8'));
const snapshot=JSON.parse(readFileSync(process.argv[2]??`${homedir()}/session-analytics-lanes/reference/snapshot-noindex-51ea561.json`,'utf8'));
const reference=new Map(snapshot.sessions.map(s=>[s.sessionKey,s]));
const cutoff=snapshot.generatedAt;
const zero=()=>({input:0,cacheRead:0,cacheWrite:0,output:0,costUsd:0});
const add=(a,b)=>{for(const k of Object.keys(a))a[k]+=b[k]??0;return a;};
const max=(a,b)=>Object.fromEntries(Object.keys(a).map(k=>[k,Math.max(a[k],b[k]??0)]));
const minus=(a,b)=>Object.fromEntries(Object.keys(a).map(k=>[k,a[k]-(b[k]??0)]));
const tokenCount=u=>u.input+u.cacheRead+u.cacheWrite+u.output;
const usage=u=>({input:u.input_tokens??0,cacheRead:u.cache_read_input_tokens??0,cacheWrite:u.cache_creation_input_tokens??0,output:u.output_tokens??0,costUsd:0});
const model=u=>({input:u.inputTokens??0,cacheRead:u.cacheReadInputTokens??0,cacheWrite:u.cacheCreationInputTokens??0,output:u.outputTokens??0,costUsd:u.costUSD??0});
const referenceUsage=s=>({input:s.tokens.uncachedInputTokens,cacheRead:s.tokens.cachedInputTokens,cacheWrite:s.tokens.cacheWriteInputTokens,output:s.tokens.outputTokens,costUsd:s.cost.totalUsd});
const groups=new Map();
const inventory={dbClaudeSessions:evidence.sessions.length,results:0,initVersions:{},duplicates:0,unknownIdentityResults:0,postCutoffResults:0};
for(const s of evidence.sessions){
  let epoch=null,version=null;
  for(const e of s.events){
    if(e.type==='init'){epoch=e.key;version=e.version;inventory.initVersions[version??'absent']=(inventory.initVersions[version??'absent']??0)+1;continue;}
    if(e.type!=='result')continue;
    inventory.results++;
    if(e.at>cutoff){inventory.postCutoffResults++;continue;}
    const identity=e.providerKey??s.providerKey??s.sessionKey;
    if(!e.providerKey&&!s.providerKey)inventory.unknownIdentityResults++;
    const g=groups.get(identity)??{key:identity,sourceSessionKeys:new Set(),createdAt:s.createdAt,lastMessageAt:s.lastMessageAt,refs:new Set(),receipts:new Map()};
    g.sourceSessionKeys.add(s.sessionKey);
    if(s.createdAt<g.createdAt)g.createdAt=s.createdAt;
    if(s.lastMessageAt>g.lastMessageAt)g.lastMessageAt=s.lastMessageAt;
    if(reference.has(identity))g.refs.add(identity);
    if((!e.providerKey||e.providerKey===s.providerKey)&&reference.has(s.sessionKey))g.refs.add(s.sessionKey);
    if(g.receipts.has(e.key)){inventory.duplicates++;if(g.receipts.get(e.key).at<=e.at)continue;}
    g.receipts.set(e.key,{...e,epoch,version});groups.set(identity,g);
  }
}
const sessions=[];
for(const g of groups.values()){
  const receipts=[...g.receipts.values()].sort((a,b)=>a.at.localeCompare(b.at)||a.key.localeCompare(b.key));
  const local=zero();let observedMaximum=zero(),cumulativeLowerBound=zero(),epochPrefix=zero(),epochMax=zero(),activeEpoch=null;
  const versions=new Set();const perModel={};let countersMissing=0,zeroCrash=0;
  const cohort=g.refs.size===1?reference.get([...g.refs][0]):null;
  for(const r of receipts){
    add(local,usage(r.usage));versions.add(r.version??'absent');
    const sumModels=Object.values(r.models).reduce((total,u)=>add(total,model(u)),zero());
    if(!Object.values(r.models).some(u=>['inputTokens','cacheReadInputTokens','cacheCreationInputTokens','outputTokens'].some(k=>u[k]!==null)))countersMissing++;
    const crash=r.reason==='error_during_execution'&&!r.costUsd&&!tokenCount(sumModels);
    if(crash){zeroCrash++;continue;}
    observedMaximum=max(observedMaximum,{...sumModels,costUsd:r.costUsd??sumModels.costUsd});
    const v=r.version?.split('.').map(Number);
    const knownOld=v&&(v[0]<2||(v[0]===2&&(v[1]<1||(v[1]===1&&v[2]<277))));
    const thisEpoch=r.epoch??'unidentified';
    if(thisEpoch!==activeEpoch){epochPrefix=knownOld?{...cumulativeLowerBound}:zero();epochMax=zero();activeEpoch=thisEpoch;}
    epochMax=max(epochMax,{...sumModels,costUsd:r.costUsd??sumModels.costUsd});
    cumulativeLowerBound=max(cumulativeLowerBound,add({...epochPrefix},epochMax));
    for(const [name,u]of Object.entries(r.models))perModel[name]=max(perModel[name]??zero(),model(u));
  }
  // Real old-version init/result pairs retain identical model snapshots with zero turn usage.
  // Therefore init+version alone does NOT establish disjoint epochs in this store.
  const reportedLowerBound={...max(observedMaximum,local),costUsd:observedMaximum.costUsd};
  const ref=cohort?referenceUsage(cohort):zero();
  const fallback=cohort?.costBasis==='provider-reported';
  const missingLocalTokens=fallback&&countersMissing===receipts.length&&receipts.length>1?tokenCount(local)-tokenCount(ref):0;
  sessions.push({sessionKey:g.key,sourceSessionKeys:[...g.sourceSessionKeys],referenceSessionKeys:[...g.refs],
    referenceKind:cohort?(fallback?'conductor-result':'canonical'):'unmatched',createdAt:cohort?.createdAt??g.createdAt,
    firstResultAt:receipts[0]?.at??null,lastResultAt:receipts.at(-1)?.at??null,lastMessageAt:g.lastMessageAt,
    excludedLive:g.lastMessageAt>cutoff,resultRecords:receipts.length,versions:[...versions],zeroCrashResults:zeroCrash,
    resultsMissingModelCounters:countersMissing,accounting:'partial-observed-lower-bound',
    receiptMaximum:observedMaximum,versionAssumptionEstimate:cumulativeLowerBound,reportedLowerBound,topLevelUsage:local,reference:ref,difference:minus(reportedLowerBound,ref),
    omittedTopLevelTokens:Math.max(0,missingLocalTokens),modelsObservedMaxima:perModel,
    referenceTokensObserved:cohort?.evidence?.tokens??null,referenceAccounting:cohort?.evidence?.accounting??null,
    referenceModels:(cohort?.models??[]).map(m=>({model:m.model,...referenceUsage({tokens:m,cost:m})}))});
}
const stable=sessions.filter(s=>!s.excludedLive);
const sum=(rows,field)=>rows.reduce((total,s)=>add(total,s[field]),zero());
const describe=rows=>({sessions:rows.length,resultRecords:rows.reduce((n,s)=>n+s.resultRecords,0),reportedLowerBound:sum(rows,'reportedLowerBound'),reference:sum(rows,'reference'),topLevelUsage:sum(rows,'topLevelUsage'),omittedTopLevelTokens:rows.reduce((n,s)=>n+s.omittedTopLevelTokens,0)});
const categories=Object.fromEntries(Object.entries(Object.groupBy(stable,s=>s.referenceKind)).map(([k,v])=>[k,describe(v)]));
const monthly=Object.entries(Object.groupBy(stable,s=>s.createdAt.slice(0,7))).map(([month,rows])=>({month,...describe(rows),byEvidence:Object.fromEntries(Object.entries(Object.groupBy(rows,s=>s.referenceKind)).map(([kind,ss])=>[kind,describe(ss)]))})).sort((a,b)=>a.month.localeCompare(b.month));
const report={referenceGeneratedAt:cutoff,provider:'claude',account:'unknown',source:'conductor-sdk-result',
  method:'Cost uses the largest observed receipt as a lower bound. Old-version init markers prove insufficient: raw retained states recur unchanged across init with zero local usage. versionAssumptionEstimate audits that unsafe convention and is NOT ground truth. Result usage is disjoint top-level turn usage. Componentwise max of top-level and cumulative observations is a token lower bound, not a full tree total. Month is reference session-start cohort; exact event-month totals are unavailable.',
  sourceGuide:'https://code.claude.com/docs/en/agent-sdk/cost-tracking#accumulate-costs-across-multiple-calls',
  inventory,summary:describe(stable),categories,monthly,excludedLiveSessions:sessions.length-stable.length,sessions};
writeFileSync('.lane/conductor-aggregates.json',JSON.stringify(report,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({inventory,summary:report.summary,categories,excludedLiveSessions:report.excludedLiveSessions},null,2));
} catch {
  console.error("Conductor reconciliation could not read or validate its inputs.");
  process.exitCode = 1;
}
