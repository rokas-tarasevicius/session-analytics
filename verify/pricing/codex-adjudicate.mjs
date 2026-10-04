import fs from 'node:fs';import {createInterface} from 'node:readline';
const reference=JSON.parse(fs.readFileSync('../reference/snapshot-noindex-51ea561.json','utf8'));
const refs=new Map(reference.sessions.filter(s=>s.provider==='codex').map(s=>[s.sessionKey,s]));
const original=JSON.parse(fs.readFileSync('.lane/codex-independent-first.json'));
const independent=JSON.parse(fs.readFileSync('.lane/codex-raw-oracle.json'));
const source=JSON.parse(fs.readFileSync('.lane/codex-source-explanation.json'));
const identity=JSON.parse(fs.readFileSync('.lane/codex-identity.json'));
const evidence=JSON.parse(fs.readFileSync('.lane/codex-targeted-evidence.json'));
const rateCard=JSON.parse(fs.readFileSync('data/rate-cards.json')).models;
const fallbackCandidates=JSON.parse(fs.readFileSync('.lane/codex-fallback-candidates.json'));
const remap=new Map(identity.legacyMatches.filter(m=>!m.registeredCandidate).map(m=>[m.rawSessionKey,m.referenceSessionKey]));
const obsKey=r=>r.time+'|'+r.usage.slice(0,4).join(',');
const invalidParents=new Set(identity.invalid.map(x=>x.metadataSessionKey));
const valid=new Map([...invalidParents].map(k=>[k,new Set(evidence.validObservations[k].map(obsKey))]));
const fallback=new Set(evidence.fallbackObservations.map(r=>r.sessionKey+'|'+obsKey(r)));
const sessions=new Map();let rejected=0,rejectedInput=0,rejectedOutput=0,rejectedUsd=0,requestSizeUnknown=0;
const output=fs.openSync('.lane/codex-source-adjudicated-requests.jsonl','w');
for await(const line of createInterface({input:fs.createReadStream('.lane/codex-source-owned-requests.jsonl'),crlfDelay:Infinity})){
 const r=JSON.parse(line);const rate=rateCard[r.model];const [input,cached,out,reasoning]=r.usage;
 if(invalidParents.has(r.sessionKey)&&!valid.get(r.sessionKey).has(obsKey(r))){rejected++;rejectedInput+=input;rejectedOutput+=out;const im=rate?.longContext&&input>rate.longContext.thresholdInputTokens?rate.longContext.inputMultiplier:1,om=rate?.longContext&&input>rate.longContext.thresholdInputTokens?rate.longContext.outputMultiplier:1;rejectedUsd+=rate?((input-cached)*rate.inputPerMillion*im+cached*rate.cachedInputPerMillion*im+out*rate.outputPerMillion*om)/1e6:0;continue;}
 r.requestSizeKnown=!fallback.has(r.sessionKey+'|'+obsKey(r));if(!r.requestSizeKnown)requestSizeUnknown++;
 r.sessionKey=remap.get(r.sessionKey)??r.sessionKey;
 fs.writeSync(output,JSON.stringify(r)+'\n');if(r.liveAfterReference||!refs.has(r.sessionKey))continue;
 let s=sessions.get(r.sessionKey);if(!s){s={sessionKey:r.sessionKey,inputTokens:0,cachedInputTokens:0,uncachedInputTokens:0,outputTokens:0,reasoningOutputTokens:0,totalUsd:0,upperEstimateUsd:0,calls:0,models:{}};sessions.set(r.sessionKey,s);}
 const long=r.requestSizeKnown&&rate?.longContext&&input>rate.longContext.thresholdInputTokens,im=long?rate.longContext.inputMultiplier:1,om=long?rate.longContext.outputMultiplier:1;
 const usd=rate?((input-cached)*rate.inputPerMillion*im+cached*rate.cachedInputPerMillion*im+out*rate.outputPerMillion*om)/1e6:0;
 const upper=rate?usd+(input-cached)*rate.inputPerMillion*im*((rate.cacheWriteMultiplier??1)-1)/1e6:0;
 const values={inputTokens:input,cachedInputTokens:cached,uncachedInputTokens:input-cached,outputTokens:out,reasoningOutputTokens:reasoning,totalUsd:usd,upperEstimateUsd:upper,calls:1};
 for(const[k,v]of Object.entries(values))s[k]+=v;
 const m=s.models[r.model]??={};for(const[k,v]of Object.entries(values))m[k]=(m[k]??0)+v;
}
fs.closeSync(output);
const differences=[],zero=[],absent=[];
for(const r of refs.values()){const s=sessions.get(r.sessionKey);if(!s){if(!r.tokens.inputTokens&&!r.tokens.outputTokens)zero.push(r.sessionKey);else absent.push(r.sessionKey);continue;}
 const delta={};for(const k of ['inputTokens','cachedInputTokens','uncachedInputTokens','outputTokens','reasoningOutputTokens'])if(s[k]!==r.tokens[k])delta[k]=s[k]-r.tokens[k];
 for(const k of ['totalUsd','upperEstimateUsd'])if(Math.abs(s[k]-r.cost[k])>1e-7)delta[k]=s[k]-r.cost[k];
 for(const [model,m]of Object.entries(s.models)){const rm=r.models.find(m=>m.model===model);if(!rm){delta['model:'+model]='absent';continue;}for(const[k,v]of Object.entries(m))if(Math.abs(v-rm[k])>1e-7)delta[model+':'+k]=v-rm[k];}
 if(Object.keys(delta).length)differences.push({sessionKey:r.sessionKey,delta});
}
const imap=new Map(independent.sessions.map(s=>[s.sessionKey,s])),sourceMap=new Map(source.sessions.map(s=>[s.sessionKey,s]));
const initialDiffs=original.differences.map(d=>({sessionKey:d.sessionKey,originalDelta:d,sourceExplained:!differences.some(x=>x.sessionKey===d.sessionKey),classification:invalidParents.has(d.sessionKey)?'filename-identity-validation':evidence.fallbackObservations.some(x=>x.sessionKey===d.sessionKey)?'activity-ownership-and-cumulative-only-context': 'activity-ownership-model-fallback-or-initial-metadata-key'}));
for(const f of evidence.fallbackObservations){const s=sourceMap.get(f.sessionKey);if(!s)continue;const candidate=fallbackCandidates.find(r=>r.sessionKey===f.sessionKey&&obsKey(r)===obsKey(f));if(candidate?.independentPresent)continue;const model=candidate?.model;const rate=rateCard[model];if(!rate)continue;const [input,cached,output]=f.usage,im=candidate?.requestSizeKnown!==false&&rate.longContext&&input>rate.longContext.thresholdInputTokens?rate.longContext.inputMultiplier:1,om=candidate?.requestSizeKnown!==false&&rate.longContext&&input>rate.longContext.thresholdInputTokens?rate.longContext.outputMultiplier:1;const usd=((input-cached)*rate.inputPerMillion*im+cached*rate.cachedInputPerMillion*im+output*rate.outputPerMillion*om)/1e6;s.inputTokens-=input;s.outputTokens-=output;s.totalUsd-=usd;s.upperEstimateUsd-=usd+(input-cached)*rate.inputPerMillion*im*((rate.cacheWriteMultiplier??1)-1)/1e6;}
const ownershipDelta={sessions:0,inputTokens:0,outputTokens:0,totalUsd:0,upperEstimateUsd:0,absoluteUsd:0};
for(const[k,s]of sourceMap){const i=imap.get(k);if(!i||!refs.has(k))continue;let changed=false;for(const f of ['inputTokens','outputTokens','totalUsd','upperEstimateUsd']){const d=s[f]-i[f];ownershipDelta[f]+=d;if(Math.abs(d)>1e-7)changed=true;}ownershipDelta.absoluteUsd+=Math.abs(s.totalUsd-i.totalUsd);if(changed)ownershipDelta.sessions++;}
const result={referenceGeneratedAt:reference.generatedAt,referenceSessions:refs.size,matchedPositiveSessions:sessions.size,zeroTokenSessions:zero.length,absentPositiveSessions:absent,liveReferenceSessionsExcluded:0,invalidIdentityRequestsExcluded:rejected,invalidIdentityInputTokens:rejectedInput,invalidIdentityOutputTokens:rejectedOutput,invalidIdentityUsd:rejectedUsd,cumulativeOnlyTargetedCorrections:requestSizeUnknown,legacyMatchedSessions:remap.size,differences,ownershipContractDisagreement:ownershipDelta,initialDifferenceAdjudication:initialDiffs,limits:['Source-activity replay explains current implementation; broad activity vs assistant-response ownership remains an unresolved contract boundary, not established ground truth.','Independent first-pass output is preserved.','All seven positive cumulative-only observations were independently reread; none has an evidenced individual request size. The sole >272k delta must not trigger a long-context premium.']};
fs.writeFileSync('.lane/codex-adjudication.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({...result,initialDifferenceAdjudication:undefined},null,2));
