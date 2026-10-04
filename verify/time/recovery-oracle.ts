/** Independent time-evidence oracle. Reads local stores read-only; emits counters,
 * timestamps and hashed session keys only. No production imports. Raw identifiers,
 * paths and message content never leave memory. Written before source inspection. */
import { DatabaseSync } from '../shared/sqlite.ts';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
function main() {
const home = homedir();
const ref = JSON.parse(readFileSync(join(home, 'session-analytics-lanes/reference/snapshot-noindex-51ea561.json'), 'utf8'));
const cutoff = Date.parse(ref.generatedAt);
const publicByKey = new Map<string, any>(ref.sessions.map((s: any) => [s.sessionKey, s]));
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const instant = (v: unknown): string | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const normalized = typeof v === 'string' && /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?$/.test(v) ? v.replace(' ', 'T')+'Z' : v;
  const n = typeof normalized === 'number' ? normalized : Date.parse(normalized);
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
};
const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
const sum = (v: Record<string, number>) => Object.values(v).reduce((a, b) => a + b, 0);
const db = new DatabaseSync(join(home, 'Library/Application Support/com.conductor.app/conductor.db'), { readOnly: true });
const raw = new Map<string, any>();
for (const r of db.prepare('SELECT id, claude_session_id, agent_type, created_at, updated_at FROM sessions').iterate() as any) {
 const sessionKey = hash(`claude:${r.claude_session_id}`);
 const reference = publicByKey.get(sessionKey);
 if (!reference || reference.provider !== 'claude' || reference.transcript.files !== 0) continue;
 raw.set(r.id, { sessionKey, provider: r.agent_type, createdAt: instant(r.created_at), updatedAt: instant(r.updated_at), maxMessageAt: null,
  resultCount: 0, resultTimestampCount: 0, resultRowDays: new Set<string>(), resultRowMonths: new Set<string>(), latestResultRowAt: null,
  resultReportedCosts: [], assistantUsageRecords: 0, assistantUsageTimestampRecords: 0, resultMetadataFields: new Set<string>(), resultUsageFields: new Set<string>() });
}
let rows = 0; let resultCount = 0; let afterCutoffRows = 0;
const messages = db.prepare("SELECT session_id, created_at, content FROM session_messages WHERE role='assistant' AND session_id=?");
for (const id of raw.keys()) for (const r of messages.iterate(id) as any) {
 rows++; const s = raw.get(r.session_id); if (!s) continue;
 const rowAt = instant(r.created_at);
 if (rowAt && (!s.maxMessageAt || rowAt > s.maxMessageAt)) s.maxMessageAt = rowAt;
 if (rowAt && Date.parse(rowAt) > cutoff) { afterCutoffRows++; continue; }
 for (const line of (r.content || '').split('\n')) {
  let e: any; try { e = JSON.parse(line); } catch { continue; }
  if (e?.type === 'assistant' && e.message?.usage) {
   s.assistantUsageRecords++; if (instant(e.timestamp)) s.assistantUsageTimestampRecords++;
  }
  if (e?.type !== 'result') continue;
  resultCount++; s.resultCount++;
  if (instant(e.timestamp)) s.resultTimestampCount++;
  if (rowAt) { s.resultRowDays.add(rowAt.slice(0,10)); s.resultRowMonths.add(rowAt.slice(0,7)); s.latestResultRowAt = !s.latestResultRowAt || rowAt > s.latestResultRowAt ? rowAt : s.latestResultRowAt; }
  if (typeof e.total_cost_usd === 'number') s.resultReportedCosts.push(number(e.total_cost_usd));
  Object.keys(e.conductor_sdk_metadata || {}).forEach(k => s.resultMetadataFields.add(k));
  Object.keys(e.usage || {}).forEach(k => s.resultUsageFields.add(k));
 }
}
db.close();
const recovered: any[] = []; const excluded: string[] = [];
for (const s of raw.values()) {
 const p = publicByKey.get(s.sessionKey); if (!p || p.provider !== 'claude' || p.transcript.files !== 0) continue;
 if ((s.maxMessageAt && Date.parse(s.maxMessageAt) > cutoff) || (s.updatedAt && Date.parse(s.updatedAt) > cutoff)) { excluded.push(s.sessionKey); continue; }
 const sourceResultCosts: number[] = s.resultReportedCosts;
 recovered.push({ sessionKey: s.sessionKey, sessionCreatedAt: s.createdAt, referenceCreatedAt: p.createdAt, referenceUpdatedAt: p.updatedAt, sourceUpdatedAt: s.updatedAt, sourceLatestMessageAt: s.maxMessageAt,
  sourceResultCount: s.resultCount, sourceResultsWithTimestamp: s.resultTimestampCount,
  sourceResultReceiptDays: [...s.resultRowDays].sort(), sourceResultReceiptMonths: [...s.resultRowMonths].sort(),
  sourceLastResultReceiptAt: s.latestResultRowAt, sourceMaximumReportedCostUsd: Math.max(0, ...sourceResultCosts),
  sourceSumReportedCostUsd: sourceResultCosts.reduce((a,b)=>a+b,0),
  sourceAssistantUsageRecords: s.assistantUsageRecords, sourceAssistantUsageTimestampRecords: s.assistantUsageTimestampRecords,
  // Receipt insertion times do not establish the distribution of cumulative SDK usage.
  oracleExpectedDatedCostUsd: 0, referenceDatedCostUsd: sum(p.spendByDay), referenceTotalCostUsd: p.cost.totalUsd,
  referenceInputTokens: p.tokens.inputTokens, referenceOutputTokens: p.tokens.outputTokens,
  referenceVelocityDatedCostUsd: (p.velocity?.buckets || []).reduce((n: number,b: any)=>n+b[3][0],0),
  referenceVelocityUndatedCostUsd: (p.velocity?.undated || []).reduce((n: number,b: any)=>n+b[1][0],0),
  referenceHasVelocity: !!p.velocity,
  referenceDurationMilliseconds: p.metrics.durationMilliseconds, sourceExpectedDurationMilliseconds: Math.max(0,Date.parse(s.updatedAt)-Date.parse(s.createdAt)),
  sourceResultMetadataFields: [...s.resultMetadataFields].sort(), sourceResultUsageFields: [...s.resultUsageFields].sort(),
 });
}
const cursorSnapshot = ref.sessions.filter((s: any) => s.provider === 'cursor');
const sdkRoot = join(home, 'Library/Application Support/com.conductor.app/cursor-sdk-store');
const cursor: any = { stores: 0, files: 0, parsedRecords: 0, runs: 0, positiveUsageRuns: 0, futureRuns: 0, runsWithCreatedAt: 0, runsWithStartedAt: 0, runsWithEndedAt: 0, runsCrossingUtcDays: 0, cacheReadTokens: 0, inputTokens: 0, outputTokens: 0, malformedLines: 0, recordKeys: new Set<string>() };
function visit(dir: string) { for (const e of readdirSync(dir, {withFileTypes:true})) {
 const p = join(dir,e.name); if (e.isDirectory()) { cursor.stores++; visit(p); continue; }
 if (!e.isFile() || !/\.(ndjson|jsonl|json)$/.test(e.name)) continue;
 cursor.files++;
 for (const l of readFileSync(p,'utf8').split('\n')) {
  if (!l.trim()) continue;
  let r: any; try { r=JSON.parse(l); } catch { cursor.malformedLines++;continue; }
  cursor.parsedRecords++; Object.keys(r||{}).forEach(k=>cursor.recordKeys.add(k));
  const isRun = r && typeof r==='object' && r.usage && (r.createdAt || r.startedAt || r.endedAt);
  if (!isRun) continue;
  cursor.runs++; const dates = ['createdAt','startedAt','endedAt'].map(k=>instant(r[k]));
  if (dates.some(d=>d && Date.parse(d)>cutoff)) {cursor.futureRuns++; continue;}
  dates.forEach((d,i)=>{if(d)cursor[['runsWithCreatedAt','runsWithStartedAt','runsWithEndedAt'][i]]++;});
  if (dates[1] && dates[2] && dates[1].slice(0,10)!==dates[2].slice(0,10))cursor.runsCrossingUtcDays++;
  const input=number(r.usage.input ?? r.usage.inputTokens), output=number(r.usage.output ?? r.usage.outputTokens); cursor.inputTokens+=input;cursor.outputTokens+=output;cursor.cacheReadTokens+=number(r.usage.cacheRead ?? r.usage.cacheReadTokens);if(input+output>0)cursor.positiveUsageRuns++;
 }
}}
if(existsSync(sdkRoot))visit(sdkRoot);
cursor.recordKeys=[...cursor.recordKeys].sort();
const out = { generatedAt: ref.generatedAt, principle: 'Cumulative run/result usage has no per-request temporal distribution; receipt/session times cannot substitute. Such value remains undated.',
 conductor: { scannedAssistantRows: rows, resultCount, afterCutoffRows, recoveredSessions: recovered.length, excludedLiveSessions: excluded,
  resultTimestampRecords: recovered.reduce((n,s)=>n+s.sourceResultsWithTimestamp,0),
  crossDaySessions: recovered.filter(s=>s.sourceResultReceiptDays.length>1).length, crossMonthSessions: recovered.filter(s=>s.sourceResultReceiptMonths.length>1).length,
  totalReferenceCostUsd: recovered.reduce((n,s)=>n+s.referenceTotalCostUsd,0), totalReferenceDatedCostUsd: recovered.reduce((n,s)=>n+s.referenceDatedCostUsd,0),
  inputTokens: recovered.reduce((n,s)=>n+s.referenceInputTokens,0), outputTokens: recovered.reduce((n,s)=>n+s.referenceOutputTokens,0),
  sessions: recovered }, cursor: { ...cursor, referenceSessions:cursorSnapshot.length, referenceCostUsd:cursorSnapshot.reduce((n:any,s:any)=>n+s.cost.totalUsd,0), referenceDatedCostUsd:cursorSnapshot.reduce((n:any,s:any)=>n+sum(s.spendByDay),0), referenceVelocitySessions:cursorSnapshot.filter((s:any)=>s.velocity).length, referenceInputTokens:cursorSnapshot.reduce((n:any,s:any)=>n+s.tokens.inputTokens,0), referenceOutputTokens:cursorSnapshot.reduce((n:any,s:any)=>n+s.tokens.outputTokens,0) } };
writeFileSync('.lane/recovery-oracle.json', JSON.stringify(out,null,2)+'\n');
const {sessions,...summary}=out.conductor; console.log(JSON.stringify({conductor:summary,cursor:out.cursor},null,2));

}
try { main(); } catch { console.error('Recovery time oracle could not read or validate its local evidence.'); process.exitCode=1; }
