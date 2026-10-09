import './safe-failures.mjs';
/** Independent schema/documentation oracle. No production imports. Emits allowlisted evidence only. */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const source = process.argv[2] || new URL('../../../reference/snapshot-noindex-51ea561.json', import.meta.url);
const output = process.argv[3] || '.lane/snapshot-oracle-results.json';
const snapshot = JSON.parse(fs.readFileSync(source, 'utf8'));
const tokenFields = ['inputTokens','uncachedInputTokens','cachedInputTokens','cacheWriteInputTokens','cacheWrite5mInputTokens','cacheWrite1hInputTokens','outputTokens','reasoningOutputTokens','nonReasoningOutputTokens'];
const costs = ['inputUsd','cachedInputUsd','cacheWriteUsd','outputUsd','totalUsd','upperEstimateUsd'];
const sum=(xs,f)=>xs.reduce((a,x)=>a+Number(f(x)||0),0);
const key=x=>/^[a-f0-9]{12,64}$/.test(x||'')?x:createHash('sha256').update(String(x)).digest('hex').slice(0,12);
const mismatches=[]; let assertions=0;
function check(scope,field,actual,expected,extra={}){
 assertions++;if(actual===expected)return;
 const floating=field.startsWith('cost.')||field.startsWith('spendByDay.')||field.startsWith('velocity.execution.')||(!field.startsWith('tool.')&&/(?:Usd|Ratio|Coverage)$/.test(field));
 if(floating&&typeof actual==='number'&&typeof expected==='number'&&Math.abs(actual-expected)<=1e-9*Math.max(1,Math.abs(expected)))return;
 mismatches.push({scope,field,actual:actual??null,expected:expected??null,...extra});
}
const scopeSession=s=>({sessionKey:key(s.sessionKey),repositoryKey:key(s.repositoryId),provider:s.provider,costBasis:s.costBasis,month:s.createdAt?.slice(0,7)||'undated'});
const api=s=>s.costBasis==='api-list-price-equivalent';
const coverage=ss=>{const ms=ss.filter(s=>s.costBasis!=='provider-reported').flatMap(s=>s.models);const eligible=sum(ms,m=>m.pricingCoverage?.eligibleTokens??m.inputTokens+m.outputTokens);const priced=sum(ms,m=>m.pricingCoverage?.pricedTokens??(m.priced?m.inputTokens+m.outputTokens:0));return{eligible,priced,ratio:eligible?priced/eligible:null};};
function grouped(xs,fn){const groups=new Map();for(const x of xs){const k=fn(x);groups.set(k,[...(groups.get(k)||[]),x]);}return groups;}
function totals(ss){const c=coverage(ss);return{sessions:ss.length,inputTokens:sum(ss,s=>s.tokens.inputTokens),outputTokens:sum(ss,s=>s.tokens.outputTokens),apiEquivalentUsd:sum(ss.filter(api),s=>s.cost.totalUsd),providerReportedUsd:sum(ss.filter(s=>s.costBasis==='provider-reported'),s=>s.cost.totalUsd),pricedTokens:c.priced,eligibleTokens:c.eligible,coverage:c.ratio};}
function reconcile(scope,ss,container){
 const c=coverage(ss),su=container.summary,input=sum(ss,s=>s.tokens.inputTokens);
 const expected={sessions:ss.length,analyzedSessions:ss.filter(s=>s.transcript.status==='ok').length,missingTranscripts:ss.filter(s=>s.transcript.status==='missing').length,estimatedSpendUsd:sum(ss,s=>s.cost.totalUsd),estimatedUpperSpendUsd:sum(ss,s=>s.cost.upperEstimateUsd),apiEquivalentSpendUsd:sum(ss.filter(api),s=>s.cost.totalUsd),providerReportedSpendUsd:sum(ss.filter(s=>s.costBasis==='provider-reported'),s=>s.cost.totalUsd),totalInputTokens:input,outputTokens:sum(ss,s=>s.tokens.outputTokens),cacheReadRatio:input?sum(ss,s=>s.tokens.cachedInputTokens)/input:null,pricedTokenCoverage:c.ratio,compactions:sum(ss,s=>s.metrics.compactions),toolCalls:sum(ss,s=>s.metrics.toolCalls),topLevelSessions:ss.filter(s=>['top-level','mixed'].includes(s.executionKind)).length,subagentSessions:ss.filter(s=>['subagent','mixed'].includes(s.executionKind)).length,topLevelSpendUsd:sum(ss,s=>s.costByExecution?.topLevelUsd),subagentSpendUsd:sum(ss,s=>s.costByExecution?.subagentUsd),unpricedSessions:ss.filter(s=>s.pricedTokenCoverage!==null&&s.pricedTokenCoverage<1&&(s.tokens.inputTokens+s.tokens.outputTokens)>0).length};
 for(const [f,v] of Object.entries(expected))check(scope,`summary.${f}`,su[f],v);
 const days=new Map();for(const s of ss)for(const [day,value]of Object.entries(s.spendByDay))days.set(day,(days.get(day)||0)+value);
 const reportedDays=new Map(container.spendByDay.map(d=>[d.name,d.value]));for(const d of new Set([...days.keys(),...reportedDays.keys()]))check(scope,`spendByDay.${d}`,reportedDays.get(d)||0,days.get(d)||0);
 const mods=grouped(ss.flatMap(s=>s.models),m=>m.model),reportedModels=new Map(container.spendByModel.map(m=>[m.model,m]));
 for(const model of new Set([...mods.keys(),...reportedModels.keys()])){const ms=mods.get(model)||[],m=reportedModels.get(model)||{};for(const f of [...tokenFields,...costs,'calls'])check(scope,`model.${model}.${f}`,m[f]||0,sum(ms,x=>x[f]));check(scope,`model.${model}.priced`,m.priced,ms.every(m=>m.priced));for(const f of ['pricedTokens','eligibleTokens'])check(scope,`model.${model}.pricingCoverage.${f}`,m.pricingCoverage?.[f]||0,sum(ms,x=>x.pricingCoverage?.[f]));}
 const toolCounts=new Map();for(const s of ss)for(const [name,value]of Object.entries(s.tools))toolCounts.set(name,(toolCounts.get(name)||0)+value);
 for(const t of container.topTools)check(scope,`tool.${t.name}`,t.value,toolCounts.get(t.name)||0);
}
for(const s of snapshot.sessions){const extra=scopeSession(s),scope=`session:${extra.sessionKey}`;
 for(const f of tokenFields)check(scope,`models.${f}`,sum(s.models,m=>m[f]),s.tokens[f],extra);
 for(const f of costs)check(scope,`models.${f}`,sum(s.models,m=>m[f]),s.cost[f],extra);
 check(scope,'tokens.inputComponents',s.tokens.inputTokens,s.tokens.uncachedInputTokens+s.tokens.cachedInputTokens+s.tokens.cacheWriteInputTokens,extra);
 check(scope,'tokens.outputComponentsBounded',s.tokens.reasoningOutputTokens+s.tokens.nonReasoningOutputTokens<=s.tokens.outputTokens,true,extra);
 if(api(s))check(scope,'cost.components',s.cost.totalUsd,s.cost.inputUsd+s.cost.cachedInputUsd+s.cost.cacheWriteUsd+s.cost.outputUsd,extra);
 check(scope,'cost.execution',sum(Object.values(s.costByExecution||{}),x=>x),s.cost.totalUsd,extra);
 check(scope,'metrics.toolCalls',s.metrics.toolCalls,sum(Object.values(s.tools),x=>x),extra);
 check(scope,'metrics.modelCalls',s.metrics.modelCalls,sum(s.models,m=>m.calls),extra);
 if(api(s))check(scope,'pricedTokenCoverage',s.pricedTokenCoverage,coverage([s]).ratio,extra);
 // Daily recovery evidence and hourly velocity have different time precision.
 // A query may prove one UTC day without proving an hour; its hourly-undated
 // value is already in spendByDay and must not be added to that day again.
 const dated=sum(Object.values(s.spendByDay),x=>x);
 if(s.history){
  check(scope,'cost.datedAndUndatedUsd',dated+s.history.undatedValueUsd,s.cost.totalUsd,extra);
  check(scope,'history.tokens',sum(s.history.days,d=>d.tokens)+s.history.undatedTokens,s.tokens.inputTokens+s.tokens.outputTokens,extra);
  const days=grouped(s.history.days,d=>d.day);
  for(const day of new Set([...days.keys(),...Object.keys(s.spendByDay)]))check(scope,`spendByDay.${day}`,s.spendByDay[day]??0,sum(days.get(day)??[],d=>d.valueUsd),extra);
 // Session-dated cells are value without its own request time: outside spendByDay, inside the total.
 }else if(s.velocity)check(scope,'cost.datedAndUndatedUsd',dated+sum(s.velocity.undated,c=>c[1][0])+sum(s.velocity.sessionDated??[],c=>c[3][0]),s.cost.totalUsd,extra);
 else check(scope,'cost.datedWithinTotal',dated<=s.cost.totalUsd+1e-7,true,extra);
 if(s.conductor?.reconciliation?.receiptFloorApplied){
  check(scope,'cost.receiptFloorBasis',s.costBasis,'provider-reported',extra);
  check(scope,'cost.receiptFloorUndated',dated,0,extra);
  check(scope,'cost.receiptFloorValue',s.cost.totalUsd,s.conductor.reconciliation.reportedUsd,extra);
 }
 if(s.mcpEvidence&&api(s)){check(scope,'mcp.pricing.eligible',sum(s.mcpEvidence.pricingByDay,d=>d.eligibleTokens)+s.mcpEvidence.undatedTokens,s.tokens.inputTokens+s.tokens.outputTokens,extra);}
 if(s.velocity){const placed=[...s.velocity.buckets,...(s.velocity.sessionDated??[])],values=[...placed.map(b=>b[3]),...s.velocity.undated.map(b=>b[1])],v=Array.from({length:14},(_,i)=>sum(values,x=>x[i]));
  for(const [i,f]of [[1,'inputTokens'],[2,'uncachedInputTokens'],[3,'cachedInputTokens'],[4,'cacheWriteInputTokens'],[5,'outputTokens'],[6,'reasoningOutputTokens']])check(scope,`velocity.${f}`,v[i],s.tokens[f],extra);
  check(scope,'velocity.valueUsd',v[0],s.cost.totalUsd,extra);check(scope,'velocity.modelCalls',v[7],s.metrics.modelCalls,extra);check(scope,'velocity.toolCalls',v[8],s.metrics.toolCalls,extra);check(scope,'velocity.sessionsStarted',v[9],1,extra);
  if(api(s))check(scope,'velocity.pricedTokens',v[10],coverage([s]).priced,extra);
  for(const [kind,field]of [['top-level','topLevelUsd'],['subagent','subagentUsd'],['unknown','unknownUsd']]){
   const attributed=sum(placed,c=>s.velocity.dimensions[c[2]].executionKind===kind?c[3][0]:0)+sum(s.velocity.undated,c=>s.velocity.dimensions[c[0]].executionKind===kind?c[1][0]:0);
   check(scope,`velocity.execution.${kind}`,attributed,s.costByExecution[field],extra);
  }
  if(api(s))for(const model of s.models){const matching=[...placed.filter(c=>s.velocity.dimensions[c[2]].model===model.model).map(c=>c[3]),...s.velocity.undated.filter(c=>s.velocity.dimensions[c[0]].model===model.model).map(c=>c[1])];
   for(const [i,f]of [[0,'totalUsd'],[1,'inputTokens'],[2,'uncachedInputTokens'],[3,'cachedInputTokens'],[4,'cacheWriteInputTokens'],[5,'outputTokens'],[6,'reasoningOutputTokens'],[7,'calls']])check(scope,`velocity.model.${model.model}.${f}`,sum(matching,c=>c[i]),model[f],extra);
  }
 }
}
for(const r of snapshot.repositories)reconcile(`repository:${key(r.repository.id)}`,snapshot.sessions.filter(s=>s.repositoryId===r.repository.id),r);
reconcile('machine',snapshot.sessions,snapshot);
check('machine','summary.repositories',snapshot.summary.repositories,snapshot.repositories.length);check('machine','summary.repositoriesWithSessions',snapshot.summary.repositoriesWithSessions,new Set(snapshot.sessions.map(s=>s.repositoryId)).size);
check('machine','summary.workingSnapshots',snapshot.summary.workingSnapshots,snapshot.sessions.filter(s=>s.transcript.snapshotWhileWorking&&!s.transcript.sourceDeleted&&!s.transcript.warnings.includes('Source availability could not be checked; showing the last indexed facts.')).length);
check('machine','uniqueSessionKeys',new Set(snapshot.sessions.map(s=>s.sessionKey)).size,snapshot.sessions.length);
check('machine','repositoryMembers',snapshot.sessions.filter(s=>snapshot.repositories.some(r=>r.repository.id===s.repositoryId)).length,snapshot.sessions.length);
const result={version:1,generatedAt:snapshot.generatedAt,assertions,mismatchCount:mismatches.length,mismatchGroups:[...grouped(mismatches,m=>m.field.replace(/^(model\.[^.]+|spendByDay)\..*/, '$1'))].map(([field,ms])=>({field,count:ms.length,delta:sum(ms,m=>typeof m.actual==='number'&&typeof m.expected==='number'?m.actual-m.expected:0)})),totals:totals(snapshot.sessions),byProvider:[...grouped(snapshot.sessions,s=>s.provider)].map(([provider,ss])=>({provider,...totals(ss)})),byMonth:[...grouped(snapshot.sessions,s=>s.createdAt?.slice(0,7)||'undated')].sort().map(([month,ss])=>({month,...totals(ss)})),byRepository:[...grouped(snapshot.sessions,s=>key(s.repositoryId))].map(([repositoryKey,ss])=>({repositoryKey,...totals(ss)})),byModel:snapshot.spendByModel.map(m=>({model:m.model,inputTokens:m.inputTokens,outputTokens:m.outputTokens,totalUsd:m.totalUsd,pricedTokens:m.pricingCoverage?.pricedTokens||0,eligibleTokens:m.pricingCoverage?.eligibleTokens||0})),mismatches};
fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({assertions,mismatchCount:result.mismatchCount,mismatchGroups:result.mismatchGroups,totals:result.totals,byProvider:result.byProvider},null,2));
