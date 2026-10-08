import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { Element, Option, documentFromHtml } from '../release-dom.ts';
import { emptySession, reportedModel, tokens } from '../../src/providers/common.ts';
import type { SessionAnalytics } from '../../src/types.ts';

export function sample(): SessionAnalytics {
 const s=emptySession({id:'synthetic',path:'',cwd:null,createdAt:'2026-09-30T23:30:00Z',updatedAt:'2026-10-01T01:00:00Z'},'claude',{repository:{id:'synthetic',name:'Synthetic'},rateCard:{currency:'USD',effectiveDate:'2026-10-01',models:{}},price:()=>{throw Error('unused');}}, {source:'conductor-result',fidelity:'summary',tokens:'reported',tools:'unavailable',turns:'unavailable',timing:'provider',usageUnit:'run'});
 s.tokens=tokens(100,0,0,20);s.cost.totalUsd=10;s.cost.upperEstimateUsd=10;s.costBasis='provider-reported';s.models=[reportedModel('model-synthetic',s.tokens,6)];return s;
}
export async function harness(sessions: SessionAnalytics[]) {
 const html=await readFile(new URL('../../src/public/index.html',import.meta.url),'utf8');
 const document=documentFromHtml(html);
 // ui.js helpers create nodes through the module-global document, as in the browser.
 (globalThis as any).document=document;
 const source=await readFile(new URL('../../src/public/app.js',import.meta.url),'utf8');
 const modules=['chart-colors','chart-scale','chart-legend','ui','view-model','providers','timestamps','export-data','evidence','velocity-data','history-coverage','tools-data','tools'];
 const helpers: Record<string,unknown>={};
 for(const name of modules) Object.assign(helpers,await import(new URL(`../../src/public/${name}.js`,import.meta.url).href));
 // The app deliberately imports this name from view-model, not evidence.
 helpers['coverageWarnings']=(await import(new URL('../../src/public/view-model.js',import.meta.url).href)).coverageWarnings;
 const fixture={sessions,repositories:[{repository:{id:'synthetic',name:'Synthetic'},warnings:[]}],warnings:[],generatedAt:'2026-10-03T12:00:00Z',velocity:{timeZone:'Europe/London'}};
 const context=createContext({...helpers,document,Option,HTMLElement:Element,Intl,URLSearchParams,fixture,console,
 window:{matchMedia:()=>({matches:false,addEventListener(){}})},localStorage:{getItem:()=>null,setItem(){}},CSS:{escape:(s:string)=>s}});
 runInContext(source.replace(/^import[\s\S]*?from ["'][^"']+["'];\n/gm,'').split('const urlParameters =')[0]!,context);
 const run=(js:string)=>runInContext(js,context);
 context['providerMark']=()=>new Element('span');
 run(`snapshot=fixture; sessionsByRepository=groupByRepository(snapshot.sessions); elements.repositoryFilter.value='all'; elements.windowStart.value=elements.windowStart.min='2026-09-01';elements.windowEnd.value=elements.windowEnd.max='2026-10-03';`);
 return {run,context,document};
}
