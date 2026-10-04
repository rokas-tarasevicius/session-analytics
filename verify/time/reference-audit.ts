// Projection-level reconciliation, independent of production aggregation/renderers.
// Run only on allowlisted snapshots. Never serialize repository names or raw IDs.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { calendarDay, instant } from './calendar-oracle.ts';
process.on('uncaughtException', () => { process.stderr.write('Time validation failed; local details suppressed.\n'); process.exit(1); });
const reference = JSON.parse(fs.readFileSync(process.argv[2] ?? '../reference/snapshot-noindex-51ea561.json', 'utf8'));
const cutoff = instant(reference.generatedAt)!;
const liveKeys = new Set<string>();
if (fs.existsSync('.lane/codex-native-independent.json')) {
  for (const key of JSON.parse(fs.readFileSync('.lane/codex-native-independent.json', 'utf8')).liveSessionKeys) liveKeys.add(key);
}
for (const path of ['.lane/time-claude-oracle.json', '.lane/codex-oracle.json']) {
  if (!fs.existsSync(path)) continue;
  const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
  for (const s of raw.sessions ?? []) if ((instant(s.lastEventAt) ?? 0) > cutoff) {
    liveKeys.add(s.sessionKey);
    for (const key of s.alternateSessionKeys ?? []) liveKeys.add(key);
  }
}
const add = (m: Record<string, number>, k: string, n: number) => { m[k] = (m[k] ?? 0) + n; };
const repositoryKey=(id:string)=>createHash('sha256').update(`repository:${id}`).digest('hex').slice(0,12);
const monthly: Record<string, Record<string, number>> = {};
const month = (date: string) => monthly[date.slice(0,7)] ??= {};
const discrepancies: any[] = [];
const groups: Record<string, Record<string, number>> = {};
const repositoryDaily: Record<string, Record<string, number>> = {};
const daily: Record<string, number> = {};
const monthlyWindows: Record<string, any> = {};
const parityErrors: any[] = [];
let sessions = 0;
for (const s of reference.sessions) {
  if (liveKeys.has(s.sessionKey) || (instant(s.lastEventAt) ?? 0) > cutoff) continue;
  sessions++;
  const p = groups[s.provider] ??= {};
  add(p, 'sessions', 1); add(p, 'usd', s.cost.totalUsd);
  const start = calendarDay(s.createdAt ?? s.firstEventAt);
  if (start) add(month(start), 'sessionStartCohortUsd', s.cost.totalUsd);
  const utc: Record<string, number> = {};
  let dated=0, shifted=0;
  for (const [day, amount] of Object.entries<number>(s.spendByDay)) {
    add(utc, day.slice(0,7), amount); add(daily,day,amount);
    add(repositoryDaily[repositoryKey(s.repositoryId)] ??= {}, day, amount);
    add(month(day),'utcEventUsd',amount); dated+=amount;
    if (start && start.slice(0,7)!==day.slice(0,7)) shifted+=amount;
  }
  if (start) { add(month(start),'undatedCohortUsd',s.cost.totalUsd-dated); if (shifted) {add(month(start),'outOfStartMonthUsd',shifted);add(month(start),'crossMonthSessions',1);} }
  add(p,'datedUsd',dated); add(p,'undatedUsd',s.cost.totalUsd-dated);
  for (const [day, amount] of Object.entries<number>(s.spendByDay)) {
    const key=day.slice(0,7), row=monthlyWindows[key]??={utcUsd:0,sparklineUsd:0,omittedUsd:0,omittedTokens:0,omittedSessions:[],byProvider:{},byModel:{},byRepository:{}};
    row.utcUsd+=amount;
    if(start?.slice(0,7)===key)row.sparklineUsd+=amount;
    else {
      row.omittedUsd+=amount;
      if(!row.omittedSessions.includes(s.sessionKey))row.omittedSessions.push(s.sessionKey);
      add(row.byProvider,s.provider,amount);add(row.byRepository,repositoryKey(s.repositoryId),amount);
    }
  }
  const limitDays: Record<string, number> = {};
  for (const b of s.limitsCache?.buckets??[]) {
    if(!b.day)continue;
    add(limitDays,b.day,b.apiEquivalentUsd);
    const key=b.day.slice(0,7), row=monthlyWindows[key];
    if(row && start?.slice(0,7)!==key) {row.omittedTokens+=b.observedTokens;add(row.byModel,b.model,b.apiEquivalentUsd);}
  }
  if(s.limitsCache)for(const day of new Set([...Object.keys(limitDays),...Object.keys(s.spendByDay)])) {
    if(Math.abs((limitDays[day]??0)-(s.spendByDay[day]??0))>1e-6)parityErrors.push({sessionKey:s.sessionKey,day,kind:'limits-spend',limitsUsd:limitDays[day]??0,spendUsd:s.spendByDay[day]??0});
  }
  const local: Record<string, number> = {};
  let vUsd=0,vInput=0,vOutput=0,vUndated=0;
  if(!s.velocity){add(p,'unavailableVelocitySessions',1);add(p,'unavailableVelocityUsd',s.cost.totalUsd);}
  for (const [day,, , values] of s.velocity?.buckets ?? []) {
    vUsd+=values[0]; vInput+=values[1];vOutput+=values[5];
    add(local,day.slice(0,7),values[0]);add(month(day),'londonVelocityUsd',values[0]);
  }
  for (const [,values] of s.velocity?.undated ?? []) {vUsd+=values[0];vUndated+=values[0];vInput+=values[1];vOutput+=values[5];}
  add(p,'velocityUsd',vUsd);add(p,'velocityUndatedUsd',vUndated);
  const error = Boolean(s.velocity) && (Math.abs(vUsd-s.cost.totalUsd)>1e-6 || vInput!==s.tokens.inputTokens || vOutput!==s.tokens.outputTokens);
  const timeDifference = [...new Set([...Object.keys(utc),...Object.keys(local)])].some(k=>Math.abs((utc[k]??0)-(local[k]??0))>1e-6);
  if (error || timeDifference || shifted) discrepancies.push({sessionKey:s.sessionKey,provider:s.provider,costBasis:s.costBasis,startMonth:start?.slice(0,7),usd:s.cost.totalUsd,datedUsd:dated,velocityUsd:vUsd,velocityUndatedUsd:vUndated,inputDifference:vInput-s.tokens.inputTokens,outputDifference:vOutput-s.tokens.outputTokens,utcMonths:utc,localMonths:local,shiftedUsd:shifted,reconciliationFailure:error});
}
const rollupDays: Record<string,number>={};
for(const s of reference.sessions)for(const [day,n]of Object.entries<number>(s.spendByDay))add(rollupDays,day,n);
for(const {name,value}of reference.spendByDay)if(Math.abs(value-(rollupDays[name]??0))>1e-6)parityErrors.push({kind:'machine-rollup',day:name,difference:value-(rollupDays[name]??0)});
for(const r of reference.repositories){const expected:Record<string,number>={};for(const s of reference.sessions.filter((s:any)=>s.repositoryId===r.repository.id))for(const [d,n]of Object.entries<number>(s.spendByDay))add(expected,d,n);for(const {name,value}of r.spendByDay)if(Math.abs(value-(expected[name]??0))>1e-6)parityErrors.push({kind:'repository-rollup',repositoryKey:repositoryKey(r.repository.id),day:name,difference:value-(expected[name]??0)});}
const result={generatedAt:reference.generatedAt,timeZone:reference.velocity.timeZone,sessions,excludedLiveSessions:reference.sessions.length-sessions,groups,monthly,monthlyWindows,parityErrors,discrepancies,daily,repositoryDaily};
fs.writeFileSync('.lane/time-reference-audit.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({generatedAt:result.generatedAt,sessions,excludedLiveSessions:result.excludedLiveSessions,groups,monthly,discrepancies:discrepancies.length,reconciliationFailures:discrepancies.filter(d=>d.reconciliationFailure).length},null,2));
