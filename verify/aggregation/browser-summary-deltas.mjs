import './safe-failures.mjs';
/** Independent whole-session previous-period arithmetic vs actual Summary delta DOM. */
import {readFileSync,writeFileSync} from 'node:fs';
import {bounds,select,aggregate,windows} from './browser-oracle.mjs';
import {createDomRuntime} from './browser-dom-runtime.mjs';
const snapshot=JSON.parse(readFileSync(process.env.SNAPSHOT??new URL('../../../reference/snapshot-noindex-51ea561.json', import.meta.url),'utf8'));
for(const [i,r]of snapshot.repositories.entries())r.repository.name=`Repository ${i+1}`;
for(const s of snapshot.sessions)s.repositoryName='Repository';
const {evaluate}=await createDomRuntime(snapshot,()=>{throw Error('No network expected')});
const checks=[];
for(const window of windows){
 await evaluate(`document.querySelector('[data-window-preset="${window.replace('d','')}"]').click()`);
 if(window==='custom')await evaluate(`(()=>{const a=document.querySelector('#window-start'),b=document.querySelector('#window-end');a.value='2026-09-01';b.value='2026-09-30';a.dispatchEvent(new Event('change'));})()`);
 const b=bounds(snapshot,window);
 if(window==='all')continue;
 const days=Math.round((Date.parse(b.end)-Date.parse(b.start))/86400000)+1;
 const date=n=>new Date(Date.parse(b.start)+n*86400000).toISOString().slice(0,10);
 const previous=aggregate(select(snapshot,'custom','all',{start:date(-days),end:date(-1)})),current=aggregate(select(snapshot,window));
 for(const [metric,key]of Object.entries({spend:'estimatedSpendUsd',sessions:'sessions',input:'inputTokens',output:'outputTokens',tools:'toolCalls',compactions:'compactions'})){
  const actual=await evaluate(`({hidden:document.querySelector('#metric-${metric}-delta').hidden,text:document.querySelector('#metric-${metric}-delta').textContent.trim()})`);
  const change=previous[key]?100*(current[key]-previous[key])/previous[key]:null;
  const expected=current[key]===0&&previous[key]===0?null:previous[key]===0?`new · vs previous ${days}d`:`${Math.abs(change)<0.05?'▬':change>0?'▲':'▼'} ${Math.abs(change).toFixed(1)}% vs previous ${days}d`;
  checks.push({window,metric,current:current[key],previous:previous[key],actual:actual.hidden?null:actual.text,expected});
 }
}
const result={mode:'synthetic-dom-production-renderers',checks,mismatches:checks.filter(c=>c.actual!==c.expected)};
writeFileSync('.lane/browser-summary-deltas.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({checks:checks.length,mismatches:result.mismatches}));
