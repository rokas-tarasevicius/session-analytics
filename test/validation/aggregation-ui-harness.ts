import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { Element, Option, documentFromHtml } from '../release-dom.ts';
import { emptySession, reportedModel, tokens } from '../../src/providers/common.ts';
import type { SessionAnalytics } from '../../src/types.ts';

export function sample(): SessionAnalytics {
 const s=emptySession({id:'synthetic',path:'',cwd:null,createdAt:'2026-09-30T23:30:00Z',updatedAt:'2026-10-01T01:00:00Z'},'claude',{repository:{id:'synthetic',name:'Synthetic'},rateCard:{currency:'USD',effectiveDate:'2026-10-01',models:{}},price:()=>{throw Error('unused');}}, {source:'conductor-result',fidelity:'summary',tokens:'reported',tools:'unavailable',turns:'unavailable',timing:'provider',usageUnit:'run'});
 s.tokens=tokens(100,0,0,20);s.cost.totalUsd=10;s.cost.upperEstimateUsd=10;s.costBasis='provider-reported';s.models=[reportedModel('model-synthetic',s.tokens,6)];return s;
}

/**
 * Gives a session an activity ledger: one cell per `[model, value]` on `day` (inside the default harness window), each
 * with `input`/`output` tokens, `calls` model calls and, unless `priced` is false, every eligible token priced.
 */
export function withLedger(session: SessionAnalytics, models: Array<[string, number]>, { day = '2026-09-30', sessionDated = false, priced = true, calls = 0, input = 100, output = 20, executionKind = 'top-level' } = {}): SessionAnalytics {
 const cells=models.map(([,value],index)=>[day,12,index,[value,input,input/2,input/2,0,output,0,calls,0,0,priced?input+output:0,0,input,0]]);
 session.velocity={dimensions:models.map(([model])=>({agent:'claude-sdk',model,executionKind,effort:'unknown'})),buckets:sessionDated?[]:cells,undated:[],...(sessionDated?{sessionDated:cells}:{})} as unknown as SessionAnalytics['velocity'];
 return session;
}

export interface HarnessOptions { repositories?: Array<{ id: string; name: string }>; generatedAt?: string; timeZone?: string; start?: string; end?: string }

export async function harness(sessions: SessionAnalytics[], { repositories = [{ id: 'synthetic', name: 'Synthetic' }], generatedAt = '2026-10-03T12:00:00Z', timeZone = 'Europe/London', start = '2026-09-01', end = '2026-10-03' }: HarnessOptions = {}) {
 const html=await readFile(new URL('../../src/public/index.html',import.meta.url),'utf8');
 const document=documentFromHtml(html);
 // The shell uses descendant selectors to reach the active Velocity chip.
 document.querySelector = (selector: string) => {
   const parts = selector.trim().split(/\s+/);
   return document.body.querySelectorAll(parts.at(-1)!).find((element) => {
     let ancestor = element.parentElement;
     for (let index = parts.length - 2; index >= 0; index -= 1) {
       while (ancestor && !ancestor.matches(parts[index]!)) ancestor = ancestor.parentElement;
       if (!ancestor) return false;
       ancestor = ancestor.parentElement;
     }
     return true;
   }) ?? null;
 };
 // ui.js helpers create nodes through the module-global document, as in the browser.
 (globalThis as any).document=document;
 const source=await readFile(new URL('../../src/public/app.js',import.meta.url),'utf8');
 const modules=['format','chart-colors','chart-scale','chart-legend','ui','view-model','quiet-repositories','url-state','providers','timestamps','export-data','evidence','machines','velocity-data','history-coverage','tools-data','tools','velocity','pricing','export-menu','shared-view','subscription-data','subscription'];
 const helpers: Record<string,unknown>={};
 for(const name of modules) Object.assign(helpers,await import(new URL(`../../src/public/${name}.js`,import.meta.url).href));
 // The app deliberately imports this name from view-model, not evidence.
 helpers['coverageWarnings']=(await import(new URL('../../src/public/view-model.js',import.meta.url).href)).coverageWarnings;
 const fixture={sessions,repositories:repositories.map((repository)=>({repository,warnings:[]})),warnings:[],generatedAt,velocity:{timeZone}};
 const listeners: Array<{ name: string; listener: (event: any) => unknown; capture: boolean }> = [];
 document.addEventListener = ((name: string, listener: (event: any) => unknown, capture = false) => {
   listeners.push({ name, listener, capture });
 }) as typeof document.addEventListener;
 const context=createContext({...helpers,document,Option,HTMLElement:Element,Intl,URLSearchParams,Error,TypeError,fixture,console,navigator:{platform:""},
 window:{location:{pathname:"/",search:"",hash:""},addEventListener(){},scrollTo(){},setTimeout:()=>1,clearTimeout(){},matchMedia:()=>({matches:false,addEventListener(){}})},localStorage:{getItem:()=>null,setItem(){}},CSS:{escape:(s:string)=>s}});
 runInContext(source.replace(/^import[\s\S]*?from ["'][^"']+["'];\n/gm,'').split('switchView(viewPanels.some')[0]!.replace('const resetExportMenu =', 'let resetExportMenu ='),context);
 const run=(js:string)=>runInContext(js,context);
 context['providerMark']=()=>new Element('span');
 run(`snapshot=fixture; sessionsByRepository=groupByRepository(snapshot.sessions); elements.repositoryFilter.value='all'; elements.windowStart.value=elements.windowStart.min=${JSON.stringify(start)};elements.windowEnd.value=elements.windowEnd.max=${JSON.stringify(end)};`);
 // Capture listeners (including Export's Escape handler) run before the dashboard handler.
 const fireKey = (key: string, target = document.body) => {
   const event = { key, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
   for (const { listener } of listeners.filter(({ name }) => name === "keydown").sort((a, b) => Number(b.capture) - Number(a.capture))) listener(event);
   return event;
 };
 return {run,context,document,fireKey};
}
