import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { Element } from '../release-dom.ts';
import { normalizeTimestamp } from '../../src/public/timestamps.js';
import { dailyCountSeries, dailySpendSeries, heatLevel } from '../../src/public/view-model.js';
// Loaded dynamically like the other harnesses: ui.js is browser JavaScript without type declarations.
const ui: Record<string, unknown> = await import(new URL('../../src/public/ui.js', import.meta.url).href);

// Execute the production functions unchanged with deterministic DOM collaborators.
function productionFunction(name: string, context: Record<string, unknown>) {
  const source = fs.readFileSync(new URL('../../src/public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf('\nfunction ', start + 1);
  return vm.runInNewContext(`${source.slice(start,end)}\n${name}`, context);
}

test('time-ui: Activity excludes unknown starts and does not create a Unix-epoch session', () => {
  const elements = { activityProviderFilters: new Element(), activityTooltip: new Element(), activityHeatmap: new Element(), activityRepositories: new Element() };
  const evidence = new Element();
  const render = productionFunction('renderActivity', {
    elements, normalizeTimestamp, heatLevel, integer: new Intl.NumberFormat('en'),
    $: () => evidence, renderViewProviderFilters() {}, sessionsForProviders: (s: unknown) => s,
    node: (tag: string, text?: string, cls?: string) => { const e = new Element(tag); e.textContent=text??'';e.className=cls??'';return e; },
    clear: (e: Element) => e.replaceChildren(), renderBars() {},
  });
  render({ sessions: [
    { createdAt: '2026-09-01T12:00:00Z', transcript: { startTimeKnown: true } },
    { createdAt: '2000-01-01T00:00:00Z', transcript: { startTimeKnown: false } },
    { createdAt: 'malformed', transcript: { startTimeKnown: false } },
    { createdAt: '2026-09-01T12:00:00Z', evidence: { timing: 'file-mtime' } },
  ], repositories: [] });
  assert.equal(elements.activityHeatmap.children.reduce((sum,e)=>sum+Number(e.dataset.value??0),0),1);
  assert.match(evidence.textContent,/1\/4 sessions/);
});

test('time-ui: priced-value sparkline discloses its session-start cohort scope', () => {
  const old = {createdAt:'2026-08-31T12:00:00Z',spendByDay:{'2026-09-01':7}};
  const recent = {createdAt:'2026-09-01T12:00:00Z',spendByDay:{'2026-09-01':3},tokens:{inputTokens:1,outputTokens:1},metrics:{toolCalls:1,compactions:0}};
  const elementMap: Record<string,Element>={};
  const lookup=(key:string)=>elementMap[key]??=new Element();
  const elements = new Proxy({}, {get:(_target,key)=>lookup(String(key))});
  const series: Record<string,number[]>={};
  const labels: Record<string,string>={};
  const render = productionFunction('renderSummary', {
    ...ui, elements, snapshot: {}, $:lookup, windowDays:()=>['2026-09-01'], windowPreset:'all',
    renderHistoryCoverage(){},renderMetricValue(){},coveredValue:()=>'',money:String,percent:String,integer:new Intl.NumberFormat('en'),compact:new Intl.NumberFormat('en'),
    dailyCountSeries,dailySpendSeries,renderDelta(){},renderSparkline:(e:Element,values:number[],_days:string[],options:{label:string})=>{const key=Object.entries(elementMap).find(([,v])=>v===e)![0];series[key]=values;labels[key]=options.label;},
    renderLine(){},dailyProviderSpend(){},renderDonut(){},renderBars(){},renderRepositoryTable(){},renderWarnings(){},renderProviderEvidence(){},selectRepository(){},
  });
  render({summary:{coverage:{cost:{},apiCost:{},reportedCost:{},tokens:{},tools:{eligible:1},compactions:{}}},sessions:[recent],dailySessions:[old,recent],repositories:[],spendByModel:[],topTools:[],warnings:[]});
  assert.deepEqual(Array.from(series['#metric-spend-spark']!),[3]);
  assert.equal(dailySpendSeries([old,recent],['2026-09-01'])[0],10);
  assert.match(labels['#metric-spend-spark']!,/sessions started.*selected window/i);
});

test('time-ui: session-start sparklines exclude unknown starts and file modification dates', () => {
  const sessions = [
    {createdAt:'2026-09-01T12:00:00Z',transcript:{startTimeKnown:true}},
    {createdAt:'2026-09-01T12:00:00Z',transcript:{startTimeKnown:false}},
    {createdAt:'2026-09-01T12:00:00Z',evidence:{timing:'file-mtime'}},
  ];
  assert.deepEqual(dailyCountSeries(sessions,['2026-09-01'],()=>1),[1]);
});
