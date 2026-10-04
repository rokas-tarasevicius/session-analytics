// Only explicitly selected counters and hashed correlation keys leave this file.
import { readFile, writeFile } from 'node:fs/promises';
process.on('uncaughtException', () => { process.stderr.write('Recovery verification failed; private local details withheld.\n'); process.exit(1); });
process.on('unhandledRejection', () => { process.stderr.write('Recovery verification failed; private local details withheld.\n'); process.exit(1); });
const json = async p => JSON.parse(await readFile(p,'utf8'));
const before = await json('.lane/recovery-before.json'), after = await json('.lane/recovery-after.json');
const nativeBefore = await json('.lane/native-before.json'), nativeAfter = await json('.lane/native-after.json');
const oracle = await json('.lane/recovery-oracle.json');
const aa=new Map(after.sessions.map(s=>[s.sessionKey,s])),bb=new Map(before.sessions.map(s=>[s.sessionKey,s])),nn=new Map(nativeBefore.sessions.map(s=>[s.sessionKey,s]));
const na=new Map(nativeAfter.sessions.map(s=>[s.sessionKey,s]));
const q=(values,p)=>{const v=[...values].sort((a,b)=>a-b),i=(v.length-1)*p;return v.length?v[Math.floor(i)]+(v[Math.ceil(i)]-v[Math.floor(i)])*(i-Math.floor(i)):null;};
const pairRows=[];
const oracleDifferences=[];
for(const p of oracle.pairs){
  const n=nn.get(p.sessionKey),a=aa.get(p.sessionKey),b=bb.get(p.sessionKey),now=na.get(p.sessionKey);
  if(!n||n.evidence||!a||!b)continue;
  const live=p.native.latest>nativeBefore.generatedAt||now?.transcript.liveness==='active'||now?.transcript.snapshotWhileWorking;
  const eligible=!live&&n.transcript.completeness==='complete'&&n.pricedTokenCoverage===1&&n.cost.totalUsd>=1;
  if(!live){
    const check=(field,actual,expected)=>{if(Math.abs(actual-expected)>1e-7)oracleDifferences.push({sessionKey:p.sessionKey,field,actual,expected});};
    for(const [raw,field] of [['uncached','uncachedInputTokens'],['cacheRead','cachedInputTokens'],['cacheWrite','cacheWriteInputTokens'],['write5m','cacheWrite5mInputTokens'],['write1h','cacheWrite1hInputTokens'],['output','outputTokens']])check(field,p.native.totals[raw],n.tokens[field]);
    check('valueUsd',p.native.totals.valueUsd,n.cost.totalUsd);
    for(const m of n.models){const raw=p.native.models[m.model];check(`model.${m.model}.valueUsd`,raw?.valueUsd??0,m.totalUsd);check(`model.${m.model}.output`,raw?.output??0,m.outputTokens);}
    for(const day of new Set([...Object.keys(p.native.days),...Object.keys(n.spendByDay)]))if(day!=='undated')check(`day.${day}.valueUsd`,p.native.days[day]?.valueUsd??0,n.spendByDay[day]??0);
  }
  pairRows.push({sessionKey:p.sessionKey,live,eligible,nativeValueUsd:n.cost.totalUsd,beforeValueUsd:b.valueUsd,afterValueUsd:a.valueUsd,
    messageValueUsd:a.reconciliation?.messageValueUsd??a.valueUsd,receiptFloor:!!a.reconciliation?.receiptFloorApplied,
    outputTokensRecovered:a.reconciliation?.outputTokensRecovered??0,nativeTokens:n.tokens,beforeTokens:b.tokens,afterTokens:a.tokens,
    nativeModels:n.models.map(m=>({model:m.model,inputTokens:m.inputTokens,outputTokens:m.outputTokens,valueUsd:m.totalUsd})),
    beforeModels:b.models.map(m=>({model:m.model,inputTokens:m.inputTokens,outputTokens:m.outputTokens,valueUsd:m.totalUsd})),
    afterModels:a.models.map(m=>({model:m.model,inputTokens:m.inputTokens,outputTokens:m.outputTokens,valueUsd:m.totalUsd})),
    nativeDays:n.spendByDay,beforeDays:b.days,afterDays:a.days,nativeUndatedUsd:Math.max(0,n.cost.totalUsd-Object.values(n.spendByDay).reduce((n,v)=>n+v,0)),
    beforeUndatedUsd:Math.max(0,b.valueUsd-Object.values(b.days).reduce((n,v)=>n+v,0)),afterUndatedUsd:Math.max(0,a.valueUsd-Object.values(a.days).reduce((n,v)=>n+v,0)),
    oracleValueDifferenceUsd:p.native.totals.valueUsd-n.cost.totalUsd,oracleOutputDifference:p.native.totals.output-n.tokens.outputTokens});
}
function stats(rows,field){const positives=rows.filter(r=>r.nativeValueUsd>0),ratios=positives.map(r=>r[field]/r.nativeValueUsd),native=positives.reduce((n,r)=>n+r.nativeValueUsd,0),recovered=positives.reduce((n,r)=>n+r[field],0);return {sessions:positives.length,nativeValueUsd:native,recoveredValueUsd:recovered,aggregate:recovered/native,median:q(ratios,.5),p10:q(ratios,.1),p90:q(ratios,.9),aboveNative:positives.filter(r=>r[field]-r.nativeValueUsd>Math.max(.01,.01*r.nativeValueUsd)).length,absoluteErrorUsd:positives.reduce((n,r)=>n+Math.abs(r[field]-r.nativeValueUsd),0)};}
const settled=pairRows.filter(r=>!r.live),eligible=pairRows.filter(r=>r.eligible);
const models=new Map(),months=new Map();
for(const p of settled){
  for(const [label,rows] of [['native',p.nativeModels],['before',p.beforeModels],['after',p.afterModels]]) for(const m of rows){const r=models.get(m.model)??{model:m.model,nativeSessions:0,beforeSessions:0,afterSessions:0,nativeUsd:0,beforeUsd:0,afterUsd:0,nativeInput:0,beforeInput:0,afterInput:0,nativeOutput:0,beforeOutput:0,afterOutput:0};r[label+'Sessions']++;r[label+'Usd']+=m.valueUsd;r[label+'Input']+=m.inputTokens;r[label+'Output']+=m.outputTokens;models.set(m.model,r);}
  const month=nn.get(p.sessionKey).createdAt.slice(0,7),group=months.get(month)??[];group.push(p);months.set(month,group);
}
const recoveredMonths=new Map();
for(const [label,snapshot]of[['before',nativeBefore],['after',nativeAfter]])for(const s of snapshot.sessions.filter(s=>s.evidence?.source.startsWith('conductor'))){
 const month=s.createdAt.slice(0,7),r=recoveredMonths.get(month)??{month,beforeSessions:0,afterSessions:0,beforeUsd:0,afterUsd:0,beforeDatedUsd:0,afterDatedUsd:0};r[label+'Sessions']++;r[label+'Usd']+=s.cost.totalUsd;r[label+'DatedUsd']+=Object.values(s.spendByDay).reduce((n,v)=>n+v,0);recoveredMonths.set(month,r);
}
const worst=(rows,field)=>rows.filter(r=>r.nativeValueUsd>0).map(r=>({sessionKey:r.sessionKey,nativeValueUsd:r.nativeValueUsd,recoveredValueUsd:r[field],ratio:r[field]/r.nativeValueUsd,deltaUsd:r[field]-r.nativeValueUsd})).sort((a,b)=>Math.abs(b.deltaUsd)-Math.abs(a.deltaUsd)).slice(0,12);
const result={version:1,generatedAt:nativeAfter.generatedAt,paired:pairRows.length,excludedLive:pairRows.filter(p=>p.live).length,
 settled:{before:stats(settled,'beforeValueUsd'),messageSupplement:stats(settled,'messageValueUsd'),after:stats(settled,'afterValueUsd')},
 eligible:{before:stats(eligible,'beforeValueUsd'),messageSupplement:stats(eligible,'messageValueUsd'),after:stats(eligible,'afterValueUsd')},
 snapshotCalibration:nativeAfter.historyCoverage.recoveryCalibration,
 nativeOracleDifferences:oracleDifferences,
 tokenClasses:Object.fromEntries(Object.keys(pairRows[0].nativeTokens).map(k=>[k,Object.fromEntries(['native','before','after'].map(label=>[label,settled.reduce((n,p)=>n+p[label+'Tokens'][k],0)]))])),
 byMonth:[...months].sort().map(([month,rows])=>({month,before:stats(rows,'beforeValueUsd'),messageSupplement:stats(rows,'messageValueUsd'),after:stats(rows,'afterValueUsd')})),
 byModel:[...models.values()].sort((a,b)=>a.model.localeCompare(b.model)),recoveredMonths:[...recoveredMonths.values()].sort((a,b)=>a.month.localeCompare(b.month)),
 worstBefore:worst(settled,'beforeValueUsd'),worstAfter:worst(settled,'afterValueUsd'),pairs:pairRows};
await writeFile('.lane/calibration.json',JSON.stringify(result,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({paired:result.paired,excludedLive:result.excludedLive,eligible:result.eligible,oracleDifferences:result.nativeOracleDifferences,recoveredMonths:result.recoveredMonths},null,2));
