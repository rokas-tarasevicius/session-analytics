import fs from 'node:fs';
const rows=JSON.parse(fs.readFileSync('.lane/pricing-claude-requests.json','utf8'));
const {rates}=JSON.parse(fs.readFileSync('verify/pricing/official-rates.json','utf8'));
const price=(m,u)=>{const r=rates[m];return(u.input*r.input+u.read*r.cacheRead+u.five*r.cacheWrite5m+u.hour*r.cacheWrite1h+u.output*r.output)/1e6;};
const requests=[],bySession={},byMonth={},byModel={};
let single=0,equal=0;
for(const r of rows){
  if(r.iterations.length===1){single++;const i=r.iterations[0];if(i.input===r.uncachedInputTokens&&i.read===r.cachedInputTokens&&Math.max(i.write,i.five+i.hour)===r.cacheWriteInputTokens&&i.output===r.outputTokens)equal++;}
  if(!r.iterations.some(i=>i.type==='fallback_message'))continue;
  const baseline=price(r.model,{input:r.uncachedInputTokens,read:r.cachedInputTokens,five:r.cacheWrite5mInputTokens,hour:r.cacheWrite1hInputTokens,output:r.outputTokens});
  let expected=0,input=0,output=0;
  for(const i of r.iterations){
    // All retained attempts here produced output; official fallback docs bill both attempts.
    if(i.output===0)throw Error('Unestablished refusal-billing eligibility.');
    const v=price(i.model||r.model,i);expected+=v;input+=i.input+i.read+Math.max(i.write,i.five+i.hour);output+=i.output;
    byModel[i.model||r.model]=(byModel[i.model||r.model]||0)+v;
  }
  byModel[r.model]=(byModel[r.model]||0)-baseline;
  const d={sessionKey:r.sessionKey,timestamp:r.timestamp,referenceUsd:baseline,expectedUsd:expected,deltaUsd:expected-baseline,
    inputTokensDelta:input-r.inputTokens,outputTokensDelta:output-r.outputTokens,iterations:r.iterations};
  requests.push(d);
  bySession[r.sessionKey]=(bySession[r.sessionKey]||0)+d.deltaUsd;
  byMonth[r.timestamp.slice(0,7)]=(byMonth[r.timestamp.slice(0,7)]||0)+d.deltaUsd;
}
const result={singleIterations:single,equalSingleIterations:equal,requests,bySession,byMonth,byModel,
  totalDeltaUsd:requests.reduce((s,r)=>s+r.deltaUsd,0),inputTokensDelta:requests.reduce((s,r)=>s+r.inputTokensDelta,0),outputTokensDelta:requests.reduce((s,r)=>s+r.outputTokensDelta,0)};
fs.writeFileSync('.lane/pricing-claude-iterations.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
