import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { Element } from '../release-dom.ts';
import { normalizeTimestamp } from '../../src/public/timestamps.js';
import { activityGrid, dailyCountSeries, dailySpendSeries, heatLegend, heatLevel } from '../../src/public/view-model.js';
// Loaded dynamically like the other harnesses: ui.js is browser JavaScript without type declarations.
const ui: Record<string, unknown> = await import(new URL('../../src/public/ui.js', import.meta.url).href);
const velocityData = await import(new URL('../../src/public/velocity-data.js', import.meta.url).href);

// Execute the production functions unchanged with deterministic DOM collaborators.
function productionFunction(name: string, context: Record<string, unknown>) {
  const source = fs.readFileSync(new URL('../../src/public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf('\nfunction ', start + 1);
  return vm.runInNewContext(`${source.slice(start,end)}\n${name}`, context);
}

test('time-ui: Activity excludes unknown starts and does not create a Unix-epoch session', () => {
  const elements = { activityProviderFilters: new Element(), activityTooltip: new Element(), activityHeatmap: new Element(), activityRepositories: new Element() };
  const evidence = new Element(), key = new Element();
  const status = new Element();
  const render = productionFunction('renderActivity', {
    elements, normalizeTimestamp, activityGrid, heatLegend, heatLevel, renderProviderEmptyState: () => false,
    document: { querySelector: (selector: string) => selector === '#activity-heatmap-key' ? key : status }, integer: new Intl.NumberFormat('en'), snapshotTimeZone: () => 'UTC',
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
  assert.equal(key.children[1]!.textContent.trim(), '0');
  assert.equal(key.children.at(-2)!.textContent.trim(), '1');
  assert.deepEqual(key.children.filter(e => e.tagName === 'i').map(e => e.dataset.level), ['0', '7']);
});

test('time-ui: priced-value KPI and sparkline follow activity dates like Velocity, including earlier starts', () => {
  // A session started before the window still contributes the value it used inside the window; the KPI,
  // its sparkline and Velocity's "Usage value" card all read the same activity ledger.
  const bucket = (day: string, value: number) => [day, 12, 0, [value, 100, 100, 0, 0, 20, 0, 1, 0, 0, 120, 0, 100, 0]];
  const velocity = (cells: unknown[]) => ({ dimensions: [{ agent: 'claude-cli', model: 'm', executionKind: 'top-level', effort: 'unknown' }], buckets: cells, undated: [] });
  const old = {provider:'claude',repositoryId:'r',createdAt:'2026-08-31T12:00:00Z',spendByDay:{'2026-09-01':7},velocity:velocity([bucket('2026-08-31',1),bucket('2026-09-01',7)])};
  const recent = {provider:'claude',repositoryId:'r',createdAt:'2026-09-01T12:00:00Z',spendByDay:{'2026-09-01':3},tokens:{inputTokens:1,outputTokens:1},metrics:{toolCalls:1,compactions:0},velocity:velocity([bucket('2026-09-01',3)])};
  const elementMap: Record<string,Element>={};
  const lookup=(key:string)=>elementMap[key]??=new Element();
  const elements = new Proxy({}, {get:(_target,key)=>lookup(String(key))});
  const series: Record<string,number[]>={};
  const labels: Record<string,string>={};
  const render = productionFunction('renderSummary', {
    ...ui, ...velocityData, elements, snapshot: {}, $:lookup, windowDays:()=>['2026-09-01'], windowPreset:'all',
    velocityContext:()=>({start:'2026-09-01',end:'2026-09-01',timeZone:'Europe/London'}),repositorySessions:()=>[],spendDelta:()=>null,
    node:(tag:string,text?:string)=>{const e=new Element(tag);e.textContent=text??'';return e;},clear:(e:Element)=>e.replaceChildren(),
    renderHistoryCoverage(){},renderMetricValue(){},coveredValue:()=>'',money:(v:number)=>`$${v.toFixed(2)}`,percent:String,integer:new Intl.NumberFormat('en'),compact:new Intl.NumberFormat('en'),
    dailyCountSeries,dailySpendSeries,renderDelta(){},renderSparkline:(e:Element,values:number[],_days:string[],options:{label:string})=>{const key=Object.entries(elementMap).find(([,v])=>v===e)![0];series[key]=values;labels[key]=options.label;},
    renderLine(){},dailyProviderSpend(){},renderDonut(){},renderBars(){},renderRepositoryTable(){},renderWarnings(){},renderProviderEvidence(){},selectRepository(){},
    pricedBadge:()=>null,executionBreakdown:()=>'',subagentValue:()=>0,ledgerMoney:()=>({models:[]}),
  });
  const activity = velocityData.buildVelocity([old,recent],{start:'2026-09-01',end:'2026-09-01',group:'repository',metric:'value'});
  render({activity,summary:{coverage:{cost:{},apiCost:{},reportedCost:{},tokens:{},tools:{eligible:1},compactions:{}}},sessions:[recent],scopeSessions:[old,recent],dailySessions:[old,recent],repositories:[],topTools:[],warnings:[]});
  assert.deepEqual(Array.from(series['#metric-spend-spark']!),[10]);
  assert.equal(lookup('spend').textContent,'$10.00');
  assert.equal(velocityData.buildVelocity([old,recent],{start:'2026-09-01',end:'2026-09-01'}).totals[0],10,'Velocity reports the same total');
  assert.match(labels['#metric-spend-spark']!,/activity date \(Europe\/London\)/i);
});

test('time-ui: session-start sparklines exclude unknown starts and file modification dates', () => {
  const sessions = [
    {createdAt:'2026-09-01T12:00:00Z',transcript:{startTimeKnown:true}},
    {createdAt:'2026-09-01T12:00:00Z',transcript:{startTimeKnown:false}},
    {createdAt:'2026-09-01T12:00:00Z',evidence:{timing:'file-mtime'}},
  ];
  assert.deepEqual(dailyCountSeries(sessions,['2026-09-01'],()=>1),[1]);
});
