// Independent reconciliation of every physical-token/model/day discrepancy.
// Consumes only privacy-safe projected evidence; it never reads production code.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { price } from './pricing.mjs';
process.setUncaughtExceptionCaptureCallback(() => { console.error('Claude iteration reconciliation failed; inspect aggregate evidence.'); process.exit(1); });
const read=name=>JSON.parse(fs.readFileSync(name,'utf8'));
const raw=read('.lane/claude-raw-audit.json'),discovery=read('.lane/claude-discovery-audit.json'),oracle=read('.lane/claude-oracle.json');
const owners=new Map(discovery.sessions.map(s=>[s.directKey,s]));
const parts=raw.iterationGroups.flatMap(g=>g.occurrences.map(o=>({messageKey:g.messageKey,...o}))).filter(o=>o.iterations.length>1);
const byModel={},bySession={},months={},ds=[];
const fields=['inputTokens','uncachedInputTokens','cachedInputTokens','cacheWriteInputTokens','cacheWrite5mInputTokens','cacheWrite1hInputTokens','outputTokens','reasoningOutputTokens'];
function tokens(u){const writes=Math.max(u.cacheWrite,u.cache5m+u.cache1h);return{inputTokens:u.input+u.cacheRead+writes,uncachedInputTokens:u.input,cachedInputTokens:u.cacheRead,cacheWriteInputTokens:writes,cacheWrite5mInputTokens:u.cache5m,cacheWrite1hInputTokens:u.cache1h,outputTokens:u.output,reasoningOutputTokens:u.thinking};}
function value(model,u,time){return price(model,{input:u.input,cacheRead:u.cacheRead,cacheWrite5m:u.cache5m,cacheWrite1h:u.cache1h,cacheWriteUnknown:Math.max(0,u.cacheWrite-u.cache5m-u.cache1h),output:u.output},time).costUSD;}
for(const o of parts){
  const owner=owners.get(o.parentProviderSessionKey);assert.ok(owner,'Every fallback must resolve to a canonical parent');
  if(owner.postCutoff)continue;
  const sessionKey=owner.sessionKey,day=o.minTimestamp.slice(0,10),model=o.iterations.at(-1).model;
  assert.ok(o.models.includes(model));
  const actual=value(model,o.usage,o.minTimestamp);let expected=0;
  const change=(model,u,sign,cost)=>{const b=byModel[model]??={tokens:Object.fromEntries(fields.map(k=>[k,0])),costUSD:0,calls:0};const t=tokens(u);for(const k of fields)b.tokens[k]+=t[k]*sign;b.costUSD+=cost*sign;b.calls+=sign;};
  change(model,o.usage,-1,actual);
  for(const [i,iteration]of o.iterations.entries()){
    const usage={...iteration.usage};
    if(i===o.iterations.length-1&&usage.output===o.usage.output)usage.thinking=o.usage.thinking;
    const cost=value(iteration.model,usage,o.minTimestamp);expected+=cost;change(iteration.model,usage,1,cost);
  }
  const delta=expected-actual;
  const b=bySession[sessionKey]??={costUSD:0,days:{},addedCalls:0};b.costUSD+=delta;b.days[day]=(b.days[day]??0)+delta;b.addedCalls+=o.iterations.length-1;
  months[day.slice(0,7)]=(months[day.slice(0,7)]??0)+delta;
  ds.push({messageKey:o.messageKey,parent:o.parentProviderSessionKey,sessionKey,month:day.slice(0,7),actual,expected,delta,initial:o.iterations[0].usage});
}
for(const[model,b]of Object.entries(oracle.models)){
  const e=byModel[model];for(const k of fields)assert.equal(b.oracle.tokens[k]-b.reference.tokens[k],e?.tokens[k]??0,model+':'+k);
  assert.ok(Math.abs(b.oracle.costUSD-b.reference.costUSD-(e?.costUSD??0))<1e-8);
  assert.equal(b.oracle.calls-b.reference.calls,e?.calls??0);
}
for(const d of oracle.diffs){const e=bySession[d.sessionKey];assert.ok(Math.abs(d.deltaCostUSD+(e?.costUSD??0))<1e-8);assert.equal(d.deltaCalls+(e?.addedCalls??0),0);for(const day of new Set([...Object.keys(d.dayDelta),...Object.keys(e?.days??{})]))assert.ok(Math.abs((d.dayDelta[day]??0)+(e?.days[day]??0))<1e-8);}
const total=ds.reduce((n,d)=>n+d.delta,0);
fs.writeFileSync('.lane/claude-iterations-impact.json',JSON.stringify({total,ds,byModel,bySession,months,modelAndDayResiduals:0},null,2)+'\n');
fs.writeFileSync('.lane/claude-fallback-iterations.json',JSON.stringify({singleCount:raw.singleIterationMatches,singleMismatch:0,singleModelPresent:raw.singleIterationModelPresent,multi:parts},null,2)+'\n');
console.log(JSON.stringify({messages:ds.length,sessions:Object.keys(bySession).length,total,modelAndDayResiduals:0}));
