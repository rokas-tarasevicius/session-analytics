/** Content-free secondary analysis of raw oracle projection and reference costs. */
import fs from 'node:fs';
import {createInterface} from 'node:readline';
const snapshot=JSON.parse(fs.readFileSync(process.argv[2]??'../reference/snapshot-noindex-51ea561.json','utf8'));
const official=JSON.parse(fs.readFileSync('verify/pricing/official-rates.json','utf8'));
const raw=JSON.parse(fs.readFileSync('.lane/codex-source-explanation.json','utf8'));
const rawSessions=new Map(raw.sessions.map(s=>[s.sessionKey,s]));
const refs=new Map(snapshot.sessions.filter(s=>s.provider==='codex').map(s=>[s.sessionKey,s]));
const oldModels=new Set(['gpt-5.3-codex','gpt-5.4','gpt-5.4-mini','gpt-5.5']);
const blank=()=>({sessions:new Set(),requests:0,inputTokens:0,cachedInputTokens:0,uncachedInputTokens:0,outputTokens:0,reasoningOutputTokens:0,totalUsdDelta:0,upperEstimateUsdDelta:0});
const add=(to, key, row, total=0,upper=0)=>{const a=to[key]??=blank();a.sessions.add(row.sessionKey);a.requests++;const [input,cached,output,reasoning]=row.usage;a.inputTokens+=input;a.cachedInputTokens+=cached;a.uncachedInputTokens+=input-cached;a.outputTokens+=output;a.reasoningOutputTokens+=reasoning;a.totalUsdDelta+=total;a.upperEstimateUsdDelta+=upper;};
const histories={},historyMonths={},upperModels={},upperMonths={},beforeLaunch={},transitionDays={};
for await(const line of createInterface({input:fs.createReadStream(process.argv[3]??'.lane/codex-source-adjudicated-requests.jsonl'),crlfDelay:Infinity})){
 const r=JSON.parse(line);if(r.liveAfterReference||!refs.has(r.sessionKey)||!r.time)continue;const rate=official.rates[r.model];if(!rate)continue;
 const [input,cached,output]=r.usage,im=r.requestSizeKnown!==false&&rate.longContextThreshold&&input>rate.longContextThreshold?rate.longInputMultiplier:1,om=r.requestSizeKnown!==false&&rate.longContextThreshold&&input>rate.longContextThreshold?rate.longOutputMultiplier:1;
 const day=r.time.slice(0,10),month=day.slice(0,7);
 if(oldModels.has(r.model)){const excess=(input-cached)*rate.input*.25*im/1e6;add(upperModels,r.model,r,0,-excess);add(upperMonths,month,r,0,-excess);}
 for(const h of official.history??[]){if(h.model!==r.model||h.input===undefined)continue;
  if(day===h.untilExclusive){const extra=((input-cached)*(h.input-rate.input)*im+cached*(h.cacheRead-rate.cacheRead)*im+output*(h.output-rate.output)*om)/1e6;const upperExtra=extra+(input-cached)*(h.cacheWrite-h.input-(rate.cacheWrite-rate.input))*im/1e6;add(transitionDays,r.model,r,extra,upperExtra);}
  if(day<h.from){add(beforeLaunch,r.model,r);continue;}if(day>=h.untilExclusive)continue;
  const current=((input-cached)*rate.input*im+cached*rate.cacheRead*im+output*rate.output*om)/1e6;
  const historic=((input-cached)*h.input*im+cached*h.cacheRead*im+output*h.output*om)/1e6;
  const delta=historic-current,upperDelta=delta+(input-cached)*(h.cacheWrite-h.input-(rate.cacheWrite-rate.input))*im/1e6;
  add(histories,r.model,r,delta,upperDelta);add(historyMonths,month,r,delta,upperDelta);
 }
}
const snapshotUpperModels={},snapshotUpperMonths={},snapshotUpperSessions=new Set();let snapshotUpperExcess=0;
for(const r of refs.values()){
 const rawSession=rawSessions.get(r.sessionKey);if(rawSession?.liveAfterReference||Date.parse(r.lastEventAt)>Date.parse(snapshot.generatedAt))continue;
 for(const m of r.models){if(!oldModels.has(m.model)||m.uncachedInputTokens<=0)continue;const delta=m.upperEstimateUsd-m.totalUsd;snapshotUpperExcess+=delta;snapshotUpperSessions.add(r.sessionKey);
 const row={sessionKey:r.sessionKey,usage:[m.inputTokens,m.cachedInputTokens,m.outputTokens,m.reasoningOutputTokens]};add(snapshotUpperModels,m.model,row,0,-delta);
 add(snapshotUpperMonths,(r.firstEventAt??r.createdAt??'undated').slice(0,7),row,0,-delta);
 }
}
function clean(obj){return Object.fromEntries(Object.entries(obj).map(([k,v])=>[k,{...v,sessions:v.sessions.size}]));}
const result={referenceGeneratedAt:snapshot.generatedAt,notes:['Historical adjustments are conditional on documented rate reductions and day-granular effective dates.','Source-aligned, identity-validated requests exactly reconcile with reference token and cost rows; ownership semantics remain a separate documented/source contract ambiguity.','Snapshot upper-model totals use exact exported model costs; snapshot months are session-start cohorts.','Raw upper and historical months use request dates in the adjudicated projection; transition-day prior-rate deltas are upper possibilities, not confirmed amounts.'],historicalSessions:new Set(Object.values(histories).flatMap(h=>[...h.sessions])).size,snapshotUpperExcess,snapshotUpperSessions:snapshotUpperSessions.size,snapshotUpperModels:clean(snapshotUpperModels),snapshotUpperSessionStartMonths:clean(snapshotUpperMonths),rawHistoricalModels:clean(histories),rawHistoricalMonths:clean(historyMonths),rawUpperModels:clean(upperModels),rawUpperRequestMonths:clean(upperMonths),rawModelBeforeOfficialLaunch:clean(beforeLaunch),effectiveTransitionDayRequests:clean(transitionDays)};
fs.writeFileSync('.lane/codex-impact.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
