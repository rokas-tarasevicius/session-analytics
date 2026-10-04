/** Audit response identities against the entire LF-based legacy observation union. */
import {readFileSync,writeFileSync} from 'node:fs';
process.on('uncaughtException', () => { process.stderr.write('Time validation failed; local details suppressed.\n'); process.exit(1); });
const raw=JSON.parse(readFileSync('.lane/time-native-codex-audit.json','utf8'));
const candidates=JSON.parse(readFileSync('.lane/codex-native-audit.json','utf8'));
const legacy=JSON.parse(readFileSync('.lane/codex-observations.json','utf8'));
const rates=JSON.parse(readFileSync('data/rate-cards.json','utf8')).models;
const tuple=(u:any)=>JSON.stringify([u.inputTokens,u.cachedInputTokens,u.outputTokens,u.reasoningOutputTokens]);
const allLast=new Set<string>(legacy.observations.map((r:any)=>tuple(r.last)));
const ownNative=new Map<string,any>(raw.native.map((r:any)=>[r.responseKey,r]));
const liveKeys=new Set<string>(raw.liveSessionKeys??[]);const stableCandidates=candidates.rows.filter((r:any)=>!liveKeys.has(r.sessionKey));const excludedLiveCandidateRows=candidates.rows.filter((r:any)=>liveKeys.has(r.sessionKey));
const targetKeys=new Set<string>(stableCandidates.map((r:any)=>r.sessionKey));
const prior=new Map<number,any>();let zeroLast=0,positiveFallbacks=0,zeroDeltas=0,resets=0,openings=0;
for(const row of legacy.observations){const before=prior.get(row.fileIndex);prior.set(row.fileIndex,row.total);if(!targetKeys.has(row.sessionKey)||row.last.inputTokens+row.last.outputTokens>0)continue;zeroLast++;if(!before){openings++;continue;}if(Object.keys(row.total).some(k=>row.total[k]<before[k])){resets++;continue;}if(row.total.inputTokens-before.inputTokens+row.total.outputTokens-before.outputTokens>0)positiveFallbacks++;else zeroDeltas++;}
const sum=()=>({requests:0,inputTokens:0,cachedInputTokens:0,outputTokens:0,valueUsd:0});
const totals=sum(),months:Record<string,ReturnType<typeof sum>>={},models:Record<string,ReturnType<typeof sum>>={};let longContextRequests=0;
const rows=stableCandidates.map((candidate:any)=>{
 const native=ownNative.get(candidate.responseKey);if(!native)throw Error('An independent raw response is missing');
 const [input,cached,output,reasoning]=native.usage;const expected={inputTokens:input,cachedInputTokens:cached,outputTokens:output,reasoningOutputTokens:reasoning};
 if(tuple(expected)!==tuple(candidate.usage)||!native.compactionResponse||!native.threadMatchesFirst||!native.sourceExistedBeforeReference||allLast.has(tuple(expected)))throw Error('Native compaction claim did not independently reconcile');
 const rate=rates[native.model];if(!rate)throw Error('Missing reviewed rate');const long=!!(rate.longContext&&input>rate.longContext.thresholdInputTokens);if(long)longContextRequests++;
 const valueUsd=((input-cached)*rate.inputPerMillion*(long?rate.longContext.inputMultiplier:1)+cached*rate.cachedInputPerMillion*(long?rate.longContext.inputMultiplier:1)+output*rate.outputPerMillion*(long?rate.longContext.outputMultiplier:1))/1e6;
 const value={requests:1,inputTokens:input,cachedInputTokens:cached,outputTokens:output,valueUsd};for(const target of [totals,months[native.time.slice(0,7)]??=sum(),models[native.model]??=sum()])for(const key of Object.keys(value) as (keyof typeof value)[])target[key]+=value[key];
 return{sessionKey:native.sessionKey,responseKey:native.responseKey,time:native.time,model:native.model,...value,compactionResponse:true,threadMatchesFirst:true,sourceExistedBeforeReference:true};
});
const removed=(sessions:any[])=>{const result={sessions:sessions.length,inputTokens:0,cachedInputTokens:0,outputTokens:0,valueUsd:0,byUtcMonthValue:{} as Record<string,number>};for(const row of sessions){result.inputTokens+=row.referenceInputTokens;result.cachedInputTokens+=row.referenceCachedInputTokens;result.outputTokens+=row.referenceOutputTokens;result.valueUsd+=row.referenceValueUsd;for(const [month,value]of Object.entries(row.referenceByUtcMonthValue) as [string,number][])result.byUtcMonthValue[month]=(result.byUtcMonthValue[month]??0)+value;}return result;};
const result={provenance:{nativeAudit:'verify/time/native-codex-audit.ts',reconciliation:'verify/time/native-codex-reconcile.ts',legacyObservations:'.lane/codex-observations.json',candidateSelection:'.lane/codex-native-audit.json',referenceGeneratedAt:raw.cutoff,framing:'UTF-8 LF-only',ownership:'First session_meta identity checked against each native thread_id; filenames are discovery hints only'},excludedLiveCandidateRows,liveSessionKeys:raw.liveSessionKeys??[],newLiveSessionKeys:raw.newLiveSessionKeys??[],liveSessions:raw.liveSessions??[],removedReference:removed(raw.liveSessions??[]),newRemovedReference:removed((raw.liveSessions??[]).filter((s:any)=>s.newlyExcluded)),independentStableNativeRecords:raw.stableRecords,independentStableSessions:raw.stableSessions,independentUniqueResponseIds:raw.uniqueStableResponseIds,duplicateResponses:raw.duplicateResponses.length,nativeThreadMismatchFirst:raw.threadMismatchFirst,confirmedCompactionResponses:rows.length,confirmedCompactionSessions:new Set(rows.map((r:any)=>r.sessionKey)).size,globalLastTupleMatches:0,zeroLastObservations:zeroLast,zeroDeltaObservations:zeroDeltas,positiveFallbacks,resets,openings,longContextRequests,totals,months,models,rows};
writeFileSync('.lane/time-native-codex-evidence.json',JSON.stringify(result,null,2));writeFileSync('.lane/codex-native-independent.json',JSON.stringify(result,null,2));console.log(JSON.stringify({...result,rows:undefined},null,2));
