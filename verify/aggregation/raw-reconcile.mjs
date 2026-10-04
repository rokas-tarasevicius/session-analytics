import './safe-failures.mjs';
/** Safe follow-up aggregation of the independent raw usage facts. No transcript reads. */
import {readFileSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
const facts=JSON.parse(readFileSync('.lane/raw-oracle-facts.json','utf8'));
const snapshot=JSON.parse(readFileSync(join(homedir(),'session-analytics-lanes/reference/snapshot-noindex-51ea561.json'),'utf8'));
const ref=new Map(snapshot.sessions.map(s=>[s.sessionKey,s]));
const physical=x=>x.inputTokens+x.outputTokens;
const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:snapshot.velocity.timeZone,year:'numeric',month:'2-digit',day:'2-digit'});
const localDay=t=>formatter.format(new Date(t));
const dayDiff=[],timestampChoices=[],partialPricing=[],shifted={requests:0,sessions:0,tokens:0,byProvider:{},byMonth:{}};
const totals={stableMatched:0,tokenMatched:0,dailyMatched:0,dailyMismatched:0,rawRequests:0,streamedRequestsCrossingUtcMidnight:0};
for(const s of facts.sessions) {
  const r=ref.get(s.sessionKey);if(s.lateActive||!r)continue;totals.stableMatched++;
  // Timezone/day evidence is limited to the sessions whose raw token components
  // already match. Later targeted identity corrections are reported separately.
  if(Object.keys(s.tokens).some(k=>s.tokens[k]!==r.tokens[k]))continue;
  let shiftedSession=false;const firstDays={},lastDays={};
  for(const request of s.requestEvidence) {
    totals.rawRequests++;const amount=physical(request.tokens);const time=request.lastAt;
    if(time&&time.slice(0,10)!==localDay(time)) {
      shifted.requests++;shifted.tokens+=amount;shiftedSession=true;
      shifted.byProvider[s.provider]=(shifted.byProvider[s.provider]||0)+amount;
      shifted.byMonth[time.slice(0,7)]=(shifted.byMonth[time.slice(0,7)]||0)+amount;
    }
    const first=request.firstAt?.slice(0,10)||'undated',last=request.lastAt?.slice(0,10)||'undated';
    firstDays[first]=(firstDays[first]||0)+amount;lastDays[last]=(lastDays[last]||0)+amount;
    if(first!==last)totals.streamedRequestsCrossingUtcMidnight++;
    const unknownTtl=Math.max(0,request.tokens.cacheWriteInputTokens-request.tokens.cacheWrite5mInputTokens-request.tokens.cacheWrite1hInputTokens);
    if(unknownTtl>0) partialPricing.push({sessionKey:s.sessionKey,model:request.model,timestamp:time,unknownTtlTokens:unknownTtl,explicitClassTokens:amount-unknownTtl,totalTokens:amount});
  }
  if(shiftedSession)shifted.sessions++;
  totals.tokenMatched++;
  const actual=Object.fromEntries((r.mcpEvidence?.pricingByDay||[]).map(d=>[d.day,d.eligibleTokens]));
  if(r.mcpEvidence?.undatedTokens)actual.undated=r.mcpEvidence.undatedTokens;
  let firstMatches=true,lastMatches=true;
  for(const d of new Set([...Object.keys(firstDays),...Object.keys(lastDays),...Object.keys(actual)])) {
    if((firstDays[d]||0)!==(actual[d]||0))firstMatches=false;
    if((lastDays[d]||0)!==(actual[d]||0)){lastMatches=false;dayDiff.push({sessionKey:s.sessionKey,provider:s.provider,day:d,oracleTokens:lastDays[d]||0,referenceTokens:actual[d]||0,delta:(lastDays[d]||0)-(actual[d]||0)});}
  }
  if(!lastMatches){totals.dailyMismatched++;timestampChoices.push({sessionKey:s.sessionKey,provider:s.provider,firstMatches,lastMatches});}
  else totals.dailyMatched++;
}
const output={timeZone:snapshot.velocity.timeZone,totals,shifted,partialPricingSummary:{requests:partialPricing.length,sessions:new Set(partialPricing.map(x=>x.sessionKey)).size,unknownTtlTokens:partialPricing.reduce((a,x)=>a+x.unknownTtlTokens,0),explicitClassTokens:partialPricing.reduce((a,x)=>a+x.explicitClassTokens,0)},timestampChoices,dayDiff,partialPricing};
writeFileSync('.lane/raw-reconciliation.json',JSON.stringify(output,null,2));console.log(JSON.stringify({totals,shifted,partialPricingSummary:output.partialPricingSummary}));
