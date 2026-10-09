import assert from 'node:assert/strict';
import test from 'node:test';
import { harness, sample } from './aggregation-ui-harness.ts';

test('AGG-006: Activity never treats an explicitly unknown start as a recorded session start',async()=>{
 const s=sample();s.transcript.startTimeKnown=false;
 const h=await harness([s]);h.run('setWindowPreset("all"); renderActivity(activeView())');
 assert.equal(h.document.querySelectorAll('.heat-cell').reduce((sum,n)=>sum+Number(n.dataset['value']),0),0);
 assert.match(h.document.querySelector('#activity-evidence')!.textContent,/0\/1/);
});

test('Activity legend shows its true count range and all-off providers can be restored',async()=>{
 const first=sample(),second=sample();second.provider='codex';
 const h=await harness([first,second]);
 h.run('resetExportMenu=()=>{}; for(const button of viewButtons){if(button.dataset.viewButton==="activity") button.setAttribute("aria-current","page");else button.removeAttribute("aria-current");} renderActiveAnalyticsView(activeView())');
 const key=h.document.querySelector('#activity-heatmap-key')!;
 assert.equal(key.children[1]!.textContent.trim(),'0');
 assert.equal(key.children.at(-2)!.textContent.trim(),'2');
 assert.match(key.textContent,/Colour scale from 0 to 2 session starts per weekday-hour cell; darker means more/);
 const initial=h.document.querySelectorAll('.heat-cell').reduce((sum,n)=>sum+Number(n.dataset['value']),0);
 assert.equal(initial,2);
 h.run('viewProviderFilters.activity.clear(); renderActivity(activeView())');
 const status=h.document.querySelector('#activity-status')!;
 assert.equal(status.hidden,false);assert.match(status.textContent,/No providers selected/);
 assert.equal(h.document.querySelector('#activity-heatmap-panel')!.hidden,true);
 assert.equal(h.document.querySelector('#activity-repositories-panel')!.hidden,true);
 const button=status.querySelector('[data-focus-key="activity:select-all-providers"]')!;
 assert.match(button.textContent,/Select all providers/);button.listeners.get('click')!();
 assert.equal(status.hidden,true);assert.equal(status.textContent.trim(),'');
 assert.equal(h.document.querySelector('#activity-heatmap-panel')!.hidden,false);
 assert.equal(h.document.querySelectorAll('.heat-cell').reduce((sum,n)=>sum+Number(n.dataset['value']),0),2);
});

test('Activity reports selected providers without sessions, and selected sessions without starts',async()=>{
 const known=sample(),outside=sample();outside.provider='cursor';outside.createdAt='2025-01-01T12:00:00Z';
 const h=await harness([known,outside]);h.run('viewProviderFilters.activity=new Set(["cursor"]); renderActivity(activeView())');
 const status=h.document.querySelector('#activity-status')!;
 assert.match(status.textContent,/No sessions from the selected providers/);
 assert.match(status.textContent,/None of the 1 sessions in this window came from Cursor/);
 known.transcript.startTimeKnown=false;
 h.run('viewProviderFilters.activity=new Set(["claude"]); setWindowPreset("all"); renderActivity(activeView())');
 assert.match(status.textContent,/No known session starts/);
 assert.match(status.textContent,/None of the 1 selected sessions has a provider start timestamp/);
 assert.equal(status.querySelector('button'),null);
});

test('Activity arrow navigation follows the desktop and transposed mobile grids',async()=>{
 const h=await harness([sample()]);h.run('renderActivity(activeView())');
 const at=(day:number,hour:number)=>h.document.querySelector(`[data-day="${day}"][data-hour="${hour}"]`)!;
 const key=(day:number,hour:number,key:string)=>at(day,hour).listeners.get('keydown')!({key,preventDefault(){},stopPropagation(){}});
 key(0,0,'ArrowRight');assert.equal(at(0,1).attributes['tabindex'],'0');
 key(0,1,'ArrowDown');assert.equal(at(1,1).attributes['tabindex'],'0');
 h.context['matchMedia']=()=>({matches:true});
 key(1,1,'ArrowDown');assert.equal(at(1,2).attributes['tabindex'],'0');
 key(1,2,'ArrowRight');assert.equal(at(2,2).attributes['tabindex'],'0');
 key(2,2,'ArrowUp');assert.equal(at(2,1).attributes['tabindex'],'0');
 key(2,1,'ArrowLeft');assert.equal(at(1,1).attributes['tabindex'],'0');
 const hours=h.document.querySelectorAll('.heat-hour');
 assert.equal(hours.length,25);assert.equal(hours[2]!.textContent.trim(),'01');assert.ok(hours[2]!.className.includes('heat-hour-minor'));
});
