/** Compose independent native requests with independently proved Desktop deltas.
 * No production imports and no unchanged-snapshot subtraction as ground truth.
 */
import { addEvent, compareEventBuckets, type EventBucket } from '../shared/event-buckets.ts';
type Json = Record<string, any>;
export function compareClaude(oracle: Json, snapshot: Json, desktop: Json) {
  if(!Array.isArray(oracle.sessions)||!Array.isArray(oracle.ignored)||!Array.isArray(desktop.intervals))throw new Error('Required independent evidence unavailable');
  const keys=['inputTokens','uncachedInputTokens','cachedInputTokens','cacheWriteInputTokens','cacheWrite5mInputTokens','cacheWrite1hInputTokens','outputTokens','reasoningOutputTokens','nonReasoningOutputTokens'];
  const zero=()=>Object.fromEntries(keys.map(k=>[k,0]));
  const costs=['inputUsd','cachedInputUsd','cacheWriteUsd','outputUsd','totalUsd','upperEstimateUsd'];
  const zeroCost=()=>Object.fromEntries(costs.map(k=>[k,0]));
  const references=new Map<string, Json>(snapshot.sessions.map((s: Json)=>[s.sessionKey,s])),differences=[],checked=[];
  const check=(key: string,field: string,actual: unknown,expected: unknown)=>{if(actual===expected)return;if(typeof actual==='number'&&typeof expected==='number'&&/Usd|USD/.test(field)&&Math.abs(actual-expected)<=1e-7)return;differences.push({sessionKey:key,field,actual:actual??null,expected:expected??null});};
  for(const source of oracle.sessions){
    const s=structuredClone(source),ref=references.get(s.sessionKey);if(!ref){differences.push({sessionKey:s.sessionKey,field:'missing-session'});continue;}
    if(s.historyProfileKeys?.length===1)check(s.sessionKey,'limitsCache.profileKey',ref.limitsCache?.profileKey,s.historyProfileKeys[0]);
    s.costByExecution.unknownUsd??=0;
    if(!Array.isArray(s.eventBuckets))throw new Error('Independent event buckets unavailable');
    const supplementalBuckets=new Map<string,EventBucket>();
    for(const interval of desktop.intervals.filter((r: Json)=>r.sessionKey===s.sessionKey&&!r.liveAfterReference)){
      if(!interval.preResumeCarryoverVersion||interval.overlappingNativeMessages||interval.missingNativeMessages)throw new Error('Desktop interval has no independent ownership proof');
      for(const m of interval.models){
        if(!m.inputsMatch||m.missingApiEquivalentUsd===null||Object.values(m.delta as Record<string, number>).some(n=>n<0))throw new Error('Desktop difference is unproved');
        if(!m.missingTokens)continue;
        const delta: Record<string, number>={...zero(),inputTokens:m.delta.input+m.delta.read+m.delta.write,uncachedInputTokens:m.delta.input,cachedInputTokens:m.delta.read,cacheWriteInputTokens:m.delta.write,outputTokens:m.delta.output};
        // An aggregate receipt proves usage, not another observed request call.
        const mo=s.models[m.model]??={tokens:zero(),costUSD:0,cost:zeroCost(),pricingCoverage:{pricedTokens:0,eligibleTokens:0},calls:0};
        for(const k of keys){s.tokens[k]+=delta[k];mo.tokens[k]+=delta[k];}
        mo.costUSD+=m.missingApiEquivalentUsd;s.costUSD+=m.missingApiEquivalentUsd;
        for(const target of [s,mo])for(const f of ['pricedTokens','eligibleTokens'])target.pricingCoverage[f]+=delta.inputTokens!+delta.outputTokens!;
        const rate=desktop.rates?.[m.model];if(!rate||m.delta.read||m.delta.write)throw new Error('Desktop component-rate evidence unavailable');
        const cost={inputUsd:m.delta.input*rate.input/1e6,cachedInputUsd:0,cacheWriteUsd:0,outputUsd:m.delta.output*rate.output/1e6,totalUsd:m.missingApiEquivalentUsd,upperEstimateUsd:m.missingApiEquivalentUsd};
        for(const k of costs){s.cost[k]+=(cost as Json)[k];mo.cost[k]+=(cost as Json)[k];}
        const day=interval.endedAt?.slice(0,10);if(!day)throw new Error('Desktop delta has no known day');
        s.spendByDay[day]=(s.spendByDay[day]??0)+m.missingApiEquivalentUsd;
        s.costByExecution[m.nativePresent?'topLevelUsd':'unknownUsd']+=m.missingApiEquivalentUsd;
        addEvent(supplementalBuckets,{at:interval.endedAt,model:m.model,executionKind:m.nativePresent?'top-level':'unknown',tokens:delta,totalUsd:m.missingApiEquivalentUsd,calls:0},snapshot.velocity?.timeZone??'Europe/London');
      }
    }
    const mergedBuckets=new Map<string,EventBucket>();for(const row of [...s.eventBuckets,...supplementalBuckets.values()]){const k=JSON.stringify([row.day,row.hour,row.model,row.executionKind]);const old=mergedBuckets.get(k);if(!old)mergedBuckets.set(k,{...row});else for(const f of ['inputTokens','uncachedInputTokens','cachedInputTokens','cacheWriteInputTokens','outputTokens','reasoningOutputTokens','totalUsd','calls'] as const)old[f]+=row[f];}
    differences.push(...compareEventBuckets(ref,[...mergedBuckets.values()]));
    for(const k of keys)check(s.sessionKey,`tokens.${k}`,ref.tokens[k],s.tokens[k]);
    const statistics = new Map<string, number>((s.historyStatistics??[]).map((r: Json)=>[`${r.day}:${r.model}`,r.tokens]));
    const referenceStatistics = new Map<string, number>((ref.historyStatistics?.days??[]).map((r: Json)=>[`${r.day}:${r.model}`,r.tokens]));
    for(const cell of new Set([...statistics.keys(),...referenceStatistics.keys()]))check(s.sessionKey,`streamStatistics.${cell}`,referenceStatistics.get(cell)??0,statistics.get(cell)??0);

    for(const k of costs)check(s.sessionKey,`cost.${k}`,ref.cost[k],s.cost[k]);
    check(s.sessionKey,'pricedTokenCoverage',ref.pricedTokenCoverage,s.pricingCoverage.eligibleTokens?s.pricingCoverage.pricedTokens/s.pricingCoverage.eligibleTokens:null);
    check(s.sessionKey,'metrics.modelCalls',ref.metrics.modelCalls,s.calls);
    check(s.sessionKey,'metrics.compactions',ref.metrics.compactions,s.compactions);
    for(const day of new Set([...Object.keys(s.spendByDay),...Object.keys(ref.spendByDay)]))check(s.sessionKey,`day.${day}.Usd`,ref.spendByDay[day]??0,s.spendByDay[day]??0);
    for(const name of new Set([...Object.keys(s.models),...ref.models.map((m: Json)=>m.model)])){
      const expected=s.models[name]??{tokens:zero(),costUSD:0,cost:zeroCost(),pricingCoverage:{pricedTokens:0,eligibleTokens:0},calls:0},actual=ref.models.find((m: Json)=>m.model===name);
      for(const k of keys)check(s.sessionKey,`model.${name}.${k}`,actual?.[k]??0,expected.tokens[k]);
      for(const k of costs)check(s.sessionKey,`model.${name}.${k}`,actual?.[k]??0,expected.cost[k]);
      check(s.sessionKey,`model.${name}.calls`,actual?.calls??0,expected.calls);
      for(const field of ['pricedTokens','eligibleTokens'])check(s.sessionKey,`model.${name}.pricingCoverage.${field}`,actual?.pricingCoverage?.[field]??0,expected.pricingCoverage[field]);
    }
    for(const k of ['topLevelUsd','subagentUsd','unknownUsd'])check(s.sessionKey,`execution.${k}`,ref.costByExecution[k],s.costByExecution[k]);
    checked.push({sessionKey:s.sessionKey,tokens:s.tokens.inputTokens+s.tokens.outputTokens,usd:s.costUSD});
  }
  const covered=new Set([...checked,...oracle.ignored].map(s=>s.sessionKey));
  for(const ref of snapshot.sessions)if(ref.provider==='claude'&&!ref.evidence?.source?.startsWith('conductor')&&!covered.has(ref.sessionKey))differences.push({sessionKey:ref.sessionKey,field:'independent-native-coverage',actual:true,expected:false});
  return {checked,differences,excludedLive:oracle.ignored};
}
