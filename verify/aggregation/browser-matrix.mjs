import './safe-failures.mjs';
/** Real Chrome DOM validation; no production frontend imports for expected arithmetic. */
import { readFileSync,writeFileSync,mkdtempSync,rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve,join,extname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { aggregate,select,bounds,velocity,windows,providers,counters,velocityGroups } from './browser-oracle.mjs';
import { insightsForSnapshot } from '../../src/insights/service.ts';
import { parseInsightConfig } from '../../src/insights/config.ts';
import { createDomRuntime } from './browser-dom-runtime.mjs';
const domMode=process.env.DOM==='1';
const outputFile=domMode?'.lane/browser-dom-matrix.json':'.lane/browser-matrix.json';
writeFileSync('.lane/browser-matrix-pid.json',JSON.stringify({pid:process.pid,mode:domMode?'dom':'chrome'}));
const snapshot=JSON.parse(readFileSync(process.env.SNAPSHOT??new URL('../../../reference/snapshot-noindex-51ea561.json', import.meta.url),'utf8'));
// Replace repository labels in memory before sending to browser. Counts/keys/numeric fields unchanged.
for(const [i,r]of snapshot.repositories.entries())r.repository.name=`Repository ${i+1}`;
const repoNames=new Map(snapshot.repositories.map(r=>[r.repository.id,r.repository.name]));
for(const s of snapshot.sessions)s.repositoryName=repoNames.get(s.repositoryId)??'Repository';
const responseBody=gzipSync(Buffer.from(JSON.stringify(snapshot))).toString('base64');
let staticServer;
let origin=process.env.ORIGIN??'http://127.0.0.1:4220';
if(process.env.STATIC==='1'&&!domMode){
 staticServer=createServer((req,res)=>{try{const url=new URL(req.url,'http://localhost');const pathname=url.pathname==='/'?'/index.html':url.pathname;const file=resolve('src/public',`.${pathname}`);if(!file.startsWith(resolve('src/public')+'/'))throw Error();const body=readFileSync(file);res.setHeader('Content-Type',({'.js':'text/javascript','.html':'text/html','.css':'text/css','.svg':'image/svg+xml'})[extname(file)]??'application/octet-stream');res.end(body)}catch{res.statusCode=404;res.end('Not found')}});await new Promise(r=>staticServer.listen(4221,'127.0.0.1',r));origin='http://127.0.0.1:4221';
}
const profile=mkdtempSync(join(tmpdir(),'aggregation-chrome-')),port=9700+Math.floor(Math.random()*100);
const chrome=domMode?{kill(){}}:spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'--disable-background-networking','--disable-extensions','about:blank'],{stdio:'ignore'});
let ws;const output={generatedAt:snapshot.generatedAt,reference:true,originKind:domMode?'synthetic-dom-production-renderers':staticServer?'temporary-static-assets':'production-server',snapshotLabelSubstitution:true,views:[],checks:[],mismatches:[],exceptions:[]};
let context={};
if(!domMode)chrome.once('exit',(code,signal)=>{output.chromeExit={code,signal}});
try{
 let tabs;if(!domMode)for(let i=0;i<80;i++){try{tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();break}catch{await delay(100)}}
 if(!domMode){if(!tabs)throw Error('Chrome exited before publishing DevTools endpoint');ws=new WebSocket(tabs.find(x=>x.type==='page').webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));}
 let id=0;const pending=new Map();
 const send=(method,params={})=>domMode?Promise.resolve({}):new Promise((resolve,reject)=>{const key=++id;const timer=setTimeout(()=>{pending.delete(key);reject(Error(`CDP timeout ${method}`))},90000);pending.set(key,m=>{clearTimeout(timer);m.error?reject(Error(`CDP ${method} ${m.error.code}`)):resolve(m.result)});ws.send(JSON.stringify({id:key,method,params}))});
 ws?.addEventListener('message',async event=>{const m=JSON.parse(event.data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);return}if(m.method==='Runtime.exceptionThrown')output.exceptions.push({...context,type:'runtime',line:m.params.exceptionDetails.lineNumber,column:m.params.exceptionDetails.columnNumber});if(m.method==='Fetch.requestPaused'){const req=m.params;try{const url=new URL(req.request.url);if(url.pathname==='/api/analytics'){await send('Fetch.fulfillRequest',{requestId:req.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'application/json'},{name:'Content-Encoding',value:'gzip'}],body:responseBody});}else if(url.pathname==='/api/insights'){const report=insightsForSnapshot(snapshot,{...parseInsightConfig({}),rateCard:snapshot.rateCard,inventory:[],warnings:[]},{from:url.searchParams.get('from')||undefined,through:url.searchParams.get('through')||undefined,repositoryId:url.searchParams.get('repo-id')||undefined});await send('Fetch.fulfillRequest',{requestId:req.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify(report)).toString('base64')});}else await send('Fetch.continueRequest',{requestId:req.requestId})}catch{output.exceptions.push({...context,type:'interception'});await send('Fetch.failRequest',{requestId:req.requestId,errorReason:'Failed'})}}});
 const domRuntime=domMode?await createDomRuntime(snapshot,async input=>{const url=new URL(input,origin);const report=insightsForSnapshot(snapshot,{...parseInsightConfig({}),rateCard:snapshot.rateCard,inventory:[],warnings:[]},{from:url.searchParams.get('from')||undefined,through:url.searchParams.get('through')||undefined});return {ok:true,json:async()=>report}}):null;
 const evaluate=async expression=>{if(domRuntime)return domRuntime.evaluate(expression);const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error('DOM expression failed');return r.result?.value};
 const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`);
 const change=(selector,value)=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
 const text=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent??null`);
 const check=(metric,actual,expected)=>{const record={...context,metric,actual,expected};output.checks.push(record);if(actual!==expected)output.mismatches.push(record)};
 const head=s=>s?.split(' · ')[0].trim();
 const money=v=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:2}).format(v);
 const compact=v=>new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:1}).format(v);
 const integer=v=>new Intl.NumberFormat('en',{maximumFractionDigits:0}).format(v);
 const number=v=>new Intl.NumberFormat('en',{maximumFractionDigits:1}).format(v);
 const providerLabels={codex:'Codex',claude:'Claude',cursor:'Cursor',copilot:'Copilot CLI',opencode:'OpenCode',gemini:'Gemini CLI',unsupported:'Unsupported'};
 const providerControls=async(view,provider)=>{
  const label=providerLabels[provider];
  if(['activity','tools','skills','summary','velocity'].includes(view)){
   const selector=view==='summary'?'#daily-provider-filters input':view==='velocity'?'.velocity-providers input':`#${view}-provider-filters input`;
   // Summary markup uses the data attribute rather than a named wrapper.
   const finalSelector=view==='summary'?'[data-provider-filter]':selector;
   return evaluate(`(()=>{const sel=${JSON.stringify(finalSelector)},provider=${JSON.stringify(provider)},label=${JSON.stringify(label)};const count=document.querySelectorAll(sel).length;for(let i=0;i<count;i++){const e=document.querySelectorAll(sel)[i];const target=provider==='all'||(e.dataset.providerFilter?e.dataset.providerFilter===provider:e.closest('label').textContent.trim()===label);if(e.checked!==target){e.checked=target;e.dispatchEvent(new Event('change',{bubbles:true}));}}return count})()`);
  }
  const selector={workflow:'#workflow-provider',reliability:'.reliability-provider select',outcomes:'.outcome-controls select'}[view];
  if(selector)return change(selector,provider);return false;
 };
 await send('Page.enable');await send('Runtime.enable');await send('Fetch.enable',{patterns:[{urlPattern:'*/api/*',requestStage:'Request'}]});await send('Emulation.setTimezoneOverride',{timezoneId:'Europe/London'});await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 await send('Page.navigate',{url:origin+'/?view=summary'});
 for(let i=0;i<240;i++){if(await text('#metric-sessions')!=='—')break;await delay(250)}
 check('snapshotLoaded',await evaluate(`document.querySelector('#sync-context')?.dataset.state`),'live');
 const views=['summary','distributions','activity','velocity','costs','models','pricing','reliability','limits-cache','workflow','tools','skills','outcomes','insights'];
 for(const window of windows){
  context={window};await click(`[data-window-preset="${window.replace('d','')}"]`);if(window==='custom'){await change('#window-start','2026-09-01');await change('#window-end','2026-09-30')}
  const range=await evaluate(`({start:document.querySelector('#window-start').value,end:document.querySelector('#window-end').value})`);
  const expectedBounds=bounds(snapshot,window);if(window!=='all'){check('window.start',range.start,expectedBounds.start);check('window.end',range.end,expectedBounds.end)}
  const cohort=select(snapshot,window),expect=aggregate(cohort);
  for(const view of views){
   context={window,view,provider:'all'};writeFileSync('.lane/browser-progress.json',JSON.stringify(context));await click(`[data-view-button="${view}"]`);await delay(view==='workflow'?200:20);await providerControls(view,'all');
   if(['workflow','insights'].includes(view)){for(let i=0;i<100;i++){const busy=await evaluate(`!!document.querySelector('[data-view-panel="${view}"] [aria-busy="true"]')`);if(!busy)break;await delay(100)}}
   const shape=await evaluate(`(()=>{const p=document.querySelector('[data-view-panel="${view}"]');return {visible:!p.hidden,children:p.querySelectorAll('*').length,alerts:p.querySelectorAll('[role="alert"]').length,busy:!!p.querySelector('[aria-busy="true"]')}})()`);output.views.push({...context,...shape});
   check('panel.visible',shape.visible,true);check('panel.alerts',shape.alerts,0);
   if(view==='summary'){
    const dom=await evaluate(`Object.fromEntries(['spend','repositories','sessions','input','output','tools','compactions','live','cache'].map(k=>[k,document.querySelector('#metric-'+k).textContent]))`);
    for(const [key,value]of Object.entries({spend:money(expect.estimatedSpendUsd),repositories:String(snapshot.repositories.length),sessions:`${expect.analyzedSessions}/${expect.sessions}`,input:compact(expect.inputTokens),output:compact(expect.outputTokens),tools:compact(expect.toolCalls),compactions:integer(expect.compactions),live:integer(expect.workingSnapshots),cache:`${(expect.cacheReadRatio*100).toFixed(1)}%`}))check(`summary.${key}`,head(dom[key])?.replace(' cached','').trim(),value);
   }
   if(view==='costs'){
    const apiUpper=cohort.filter(s=>s.costBasis==='api-list-price-equivalent').reduce((a,s)=>a+s.cost.upperEstimateUsd,0);
    for(const [id,value]of [['api-total',money(expect.apiEquivalentSpendUsd)],['upper-total',money(apiUpper)],['provider-total',cohort.some(s=>s.costBasis==='provider-reported')?money(expect.providerReportedSpendUsd):'N/A'],['coverage',`${(expect.pricedTokenCoverage*100).toFixed(1)}%`]])check(`costs.${id}`,head(await text('#cost-'+id)),value);
   }
   if(view==='models')for(const metric of ['value','calls','input','output']){
    await click(`[data-model-metric="${metric}"]`);
    const rows=await evaluate(`Array.from(document.querySelectorAll('.provider-model-group')).flatMap(g=>Array.from(g.querySelectorAll('.model-row')).map(r=>({provider:g.querySelector('h2').textContent,model:r.firstElementChild.textContent,value:r.lastElementChild.textContent})))`);
    for(const r of rows){const m=expect.models.find(m=>providerLabels[m.provider]===r.provider&&m.model===r.model);if(!m)continue;const value={value:money(m.totalUsd),calls:`${integer(m.calls)} calls`,input:`${compact(m.inputTokens)} tokens`,output:`${compact(m.outputTokens)} tokens`}[metric];if(head(r.value)==='N/A'&&((metric==='value'&&m.totalUsd===0)||(metric==='calls'&&m.calls===0)||(metric!=='value'&&m.inputTokens+m.outputTokens===0)))continue;check(`models.${metric}.${m.provider}.${m.model}`,head(r.value),value)}
   }
   if(['summary','activity','velocity','tools','skills','reliability','workflow','outcomes'].includes(view))for(const provider of providers){
    if(view==='reliability'&&!['all','claude','codex','cursor'].includes(provider))continue;
    context={window,view,provider};await providerControls(view,provider);if(view==='workflow')await delay(100);
    const selected=select(snapshot,window,provider);
    if(view==='activity')check('activity.starts',await evaluate(`Array.from(document.querySelectorAll('#activity-heatmap [data-value]')).reduce((a,e)=>a+Number(e.dataset.value),0)`),selected.filter(s=>s.evidence?.timing!=='file-mtime'&&Number.isFinite(Date.parse(s.createdAt))).length);
    if(view==='summary'){
     const series=await evaluate(`(()=>{const svg=document.querySelector('#daily-spend svg');if(!svg)return [];const rows=[];svg.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));for(let i=0;i<400;i++){const tip=document.querySelector('#daily-spend .chart-tooltip');const day=tip?.querySelector('.tip-title')?.textContent;if(!day||rows.at(-1)?.day===day)break;rows.push({day,values:Array.from(tip.querySelectorAll('.tip-row')).map(r=>({provider:r.querySelector('span').textContent,value:r.querySelector('strong').textContent}))});svg.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));}return rows})()`);
     for(const row of series){const day=new Date(row.day+' 12:00:00 UTC').toISOString().slice(0,10);for(const item of row.values){const p=Object.keys(providerLabels).find(p=>providerLabels[p]===item.provider);const amount=snapshot.sessions.filter(s=>s.provider===p).reduce((a,s)=>a+(s.spendByDay[day]??0),0);check(`daily.${day}.${p}`,item.value,money(amount))}}
    }
    if(view==='velocity'){
     const expected=velocity(snapshot,window,provider);
     for(const [metric,index]of Object.entries({value:0,input:1,uncached:2,cacheRead:3,cacheWrite:4,output:5,reasoning:6,calls:7,tools:8,sessions:9})){
      await change('.velocity-controls select[aria-label="Metric"]',metric);const v=expected.totals[counters[index]];check(`velocity.${metric}`,await text('.velocity-totals article:first-child strong'),metric==='value'?money(v):number(v));
     }
     await change('.velocity-controls select[aria-label="Metric"]','value');
     if(provider==='all')for(const group of ['agent','provider','model','execution','effort']){
      await change('.velocity-controls select[aria-label="Group by"]',group);
      const rows=await evaluate(`Array.from(document.querySelectorAll('.velocity-legend [data-series]')).map(e=>({id:e.dataset.series,value:e.querySelector('strong').textContent.trim()}))`);
      const expectedGroups=velocityGroups(snapshot,window,provider,group);
      check(`velocity.groups.${group}.count`,rows.length,expectedGroups.length);
      for(const row of rows)check(`velocity.groups.${group}.${row.id}`,row.value,money(expectedGroups.find(([id])=>id===row.id)?.[1]??0));
     }
     await change('.velocity-controls select[aria-label="Group by"]','agent');
     const series=await evaluate(`(()=>{const svg=document.querySelector('.velocity-chart svg[role="group"]');if(!svg)return [];const rows=[];svg.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));for(let i=0;i<400;i++){const s=document.querySelector('.velocity-inspection strong')?.textContent;if(!s||rows.at(-1)===s)break;rows.push(s);svg.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));}return rows})()`);
     for(const row of series){const [day,value]=row.split(' · ');check(`velocity.daily.${day}`,value,money(expected.days.find(d=>d.day===day)?.valueUsd??0))}
    }
    const filteredShape=await evaluate(`(()=>{const p=document.querySelector('[data-view-panel="${view}"]');return {visible:!p.hidden,children:p.querySelectorAll('*').length,alerts:p.querySelectorAll('[role="alert"]').length}})()`);output.views.push({...context,...filteredShape});check('filtered.alerts',filteredShape.alerts,0);
   }
  }
  writeFileSync(outputFile,JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify({window,checks:output.checks.length,mismatches:output.mismatches.length,exceptions:output.exceptions.length}));
 }
}catch{output.runnerFailure={reason:'browser-validation-failed'};console.log(JSON.stringify(output.runnerFailure));process.exitCode=1}
finally{if(output.mismatches.length)process.exitCode=1;writeFileSync(outputFile,JSON.stringify(output,null,2)+'\n');ws?.close();chrome.kill();staticServer?.close();await delay(400);rmSync(profile,{recursive:true,force:true});}
