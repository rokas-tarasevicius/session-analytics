// Independent oracle: deliberately imports no analyzer code. Raw content/paths/IDs stay in memory.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { compareUnavailableCursorTime } from './time-scope.ts';
import { DatabaseSync } from '../shared/sqlite.ts';

const root = homedir();
const reference = JSON.parse(readFileSync(join(root, 'session-analytics-lanes/reference/snapshot-noindex-51ea561.json'), 'utf8'));
const cutoff = Date.parse(reference.generatedAt);
const hash = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 12);
const registrations = new Map<string, string>();
const conductorPath = join(root, 'Library/Application Support/com.conductor.app/conductor.db');
if (existsSync(conductorPath)) {
  const db = new DatabaseSync(conductorPath, { readOnly: true });
  for (const row of db.prepare('SELECT id, claude_session_id FROM sessions WHERE agent_type = ?').all('cursor') as any[]) {
    if (typeof row.claude_session_id === 'string') registrations.set(row.claude_session_id, hash(row.id));
  }
  db.close();
}
const keyFor = (id: string) => registrations.get(id) ?? hash(`cursor:${id}`);
function walk(directory: string, accept: (file: string) => boolean): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? walk(file, accept) : entry.isFile() && accept(file) ? [file] : [];
  });
}
const add = (target: Record<string, number>, key: string, count = 1) => { target[key] = (target[key] ?? 0) + count; };
const transcriptFiles = walk(join(root, '.cursor/projects'), f => f.includes('/agent-transcripts/') && f.endsWith('.jsonl'));
const transcriptSessions: any[] = [];
for (const file of transcriptFiles) {
  const id = basename(file, '.jsonl');
  const layout = file.split('/agent-transcripts/')[1]?.split('/') ?? [];
  const parentId = layout.length === 3 && layout[1] === 'subagents' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(layout[0] ?? '') ? layout[0] : null;
  const counts = { userTurns: 0, assistantMessages: 0, toolCalls: 0, records: 0, malformedRecords: 0, timestampFields: 0, usageFields: 0, modelFields: 0 };
  const tools: Record<string, number> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let record: any;
    try { record = JSON.parse(line); } catch { counts.malformedRecords++; continue; }
    counts.records++;
    if (record.role === 'user') counts.userTurns++;
    if (record.role === 'assistant') counts.assistantMessages++;
    if (record.timestamp !== undefined || record.createdAt !== undefined || record.message?.timestamp !== undefined) counts.timestampFields++;
    if (record.usage !== undefined || record.message?.usage !== undefined) counts.usageFields++;
    if (record.model !== undefined || record.message?.model !== undefined) counts.modelFields++;
    const blocks = Array.isArray(record.message?.content) ? record.message.content : [];
    for (const block of blocks) if (block.type === 'tool_use' && typeof block.name === 'string') {
      // Only documented bounded tool names can be emitted.
      if (/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(block.name)) add(tools, block.name);
      counts.toolCalls++;
    }
  }
  transcriptSessions.push({ sessionKey: keyFor(id), nativeSessionKey: hash(`cursor:${id}`), ...(parentId ? { executionKind: 'subagent', parentSessionKey: keyFor(parentId), parentNativeSessionKey: hash(`cursor:${parentId}`) } : {}), ...counts, tools, fileModifiedAfterCutoff: statSync(file).mtimeMs > cutoff });
}

const nativePath = join(root, 'Library/Application Support/Cursor/User/globalStorage/state.vscdb');
const native: any = { available: existsSync(nativePath), composerHeaders: [], composers: [], bubbleRows: 0, bubbleInputTokens: 0, bubbleOutputTokens: 0, modelCostUsd: {} };
if (native.available) {
  const db = new DatabaseSync(nativePath, { readOnly: true });
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map(t => t.name));
  native.itemTable = { parseableValues: 0, numericUsageFields: {} };
  const numericFields = new Set(['costInCents', 'costUSD', 'costUsd', 'total_cost_usd', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'input_tokens', 'output_tokens', 'totalTokens', 'total_tokens']);
  const scanUsage = (value: any, depth = 0): void => {
    if (depth > 20 || value === null || typeof value !== 'object') return;
    for (const [field, item] of Object.entries(value)) {
      if (numericFields.has(field) && typeof item === 'number' && Number.isFinite(item)) add(native.itemTable.numericUsageFields, field, item);
      scanUsage(item, depth + 1);
    }
  };
  if (tables.has('ItemTable')) for (const row of db.prepare('SELECT value FROM ItemTable').all() as any[]) {
    try { scanUsage(JSON.parse(row.value)); native.itemTable.parseableValues++; } catch { /* Opaque app state is not usage. */ }
  }
  if (tables.has('composerHeaders')) for (const row of db.prepare('SELECT composerId, createdAt, lastUpdatedAt, isSubagent, value FROM composerHeaders').all() as any[]) {
    let value: any = {}; try { value = JSON.parse(row.value); } catch { /* numeric columns remain usable */ }
    native.composerHeaders.push({ sessionKey: keyFor(row.composerId), createdAt: row.createdAt, lastUpdatedAt: row.lastUpdatedAt, isSubagent: Boolean(row.isSubagent), isDraft: value.isDraft, totalLinesAdded: value.totalLinesAdded, totalLinesRemoved: value.totalLinesRemoved });
  }
  if (tables.has('cursorDiskKV')) for (const row of db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%' OR key LIKE 'bubbleId:%'").all() as any[]) {
    let value: any; try { value = JSON.parse(row.value); } catch { continue; }
    if (row.key.startsWith('composerData:')) {
      const usage = value.usageData ?? {};
      let costUsd = 0, reportedValueEntries = 0;
      for (const [model, item] of Object.entries(usage) as [string, any][]) if (typeof item?.costInCents === 'number' && Number.isFinite(item.costInCents) && item.costInCents >= 0) {
        reportedValueEntries++;
        costUsd += item.costInCents / 100;
        if (/^[a-zA-Z0-9_.:/-]{1,160}$/.test(model)) add(native.modelCostUsd, model, item.costInCents / 100);
      }
      const composerId = value.composerId ?? row.key.slice(13);
      const diskBubbles = (db.prepare("SELECT count(*) n FROM cursorDiskKV WHERE key >= ? AND key < ? AND json_valid(value) AND CASE WHEN json_valid(value) THEN json_type(value) = 'object' ELSE 0 END").get(`bubbleId:${composerId}:`, `bubbleId:${composerId};`) as any).n;
      native.composers.push({ sessionKey: keyFor(composerId), isDraft: value.isDraft, createdAt: value.createdAt, lastUpdatedAt: value.lastUpdatedAt, costUsd, reportedValueEntries, usageModels: Object.keys(usage).length, inlineBubbles: Array.isArray(value.conversation) ? value.conversation.length : 0, diskBubbles, conversationHeaders: value.fullConversationHeadersOnly?.length ?? 0, totalLinesAdded: value.totalLinesAdded, totalLinesRemoved: value.totalLinesRemoved });
    } else {
      native.bubbleRows++;
      native.bubbleInputTokens += typeof value.tokenCount?.inputTokens === 'number' ? value.tokenCount.inputTokens : 0;
      native.bubbleOutputTokens += typeof value.tokenCount?.outputTokens === 'number' ? value.tokenCount.outputTokens : 0;
    }
  }
  db.close();
}

const tracking: any[] = [];
for (const file of walk(join(root, '.cursor/ai-tracking'), f => /\.(?:db|sqlite)$/.test(f))) {
  const db = new DatabaseSync(file, { readOnly: true });
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]) {
    if (!/^[a-z_]+$/.test(row.name)) continue;
    tracking.push({ table: row.name, rows: (db.prepare(`SELECT count(*) AS n FROM "${row.name}"`).get() as any).n });
  }
  db.close();
}

const referenceCursor = reference.sessions.filter((s: any) => s.provider === 'cursor');
const byKey = new Map(referenceCursor.map((s: any) => [s.sessionKey, s]));
const diffs: any[] = [];
const timeFields: any[] = [];
let matched = 0, suppressedBySdk = 0, registeredKeyDifferences = 0;
for (const session of transcriptSessions) {
  if (session.fileModifiedAfterCutoff) continue;
  const ref: any = byKey.get(session.sessionKey) ?? byKey.get(session.nativeSessionKey);
  if (!ref) { diffs.push({ sessionKey: session.sessionKey, missing: true, ...Object.fromEntries(['userTurns', 'assistantMessages', 'toolCalls'].map(k => [k, session[k]])) }); continue; }
  matched++;
  if (ref.sessionKey !== session.sessionKey) registeredKeyDifferences++;
  // Current fidelity rule suppresses transcript copies when an SDK summary exists.
  // SDK assistant-message counts are unavailable: differences here are not lost sessions.
  if (ref.evidence?.source === 'cursor-sdk') { suppressedBySdk++; continue; }
  timeFields.push(...compareUnavailableCursorTime(ref, 'activity-only', session));
  for (const field of ['userTurns', 'assistantMessages', 'toolCalls']) if (ref.metrics[field] !== session[field]) diffs.push({ sessionKey: session.sessionKey, field, expected: session[field], actual: ref.metrics[field] });
  if ((ref.tokens?.inputTokens ?? 0) + (ref.tokens?.outputTokens ?? 0) !== 0) diffs.push({ sessionKey: session.sessionKey, field: 'transcriptTokensShouldBeUnavailable' });
}
const otherStores: any[] = [];
for (const file of walk(join(root, 'Library/Application Support/Cursor'), f => /(?:state\.vscdb(?:\.backup)?|\.db)$/.test(f))) {
  if (file === nativePath) continue;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map(t => t.name));
    if (tables.has('conversations')) {
      const rows = (db.prepare('SELECT id, source, updated_at FROM conversations').all() as any[]).map(r => ({ sessionKey: hash(`cursor:${r.id}`), source: r.source === 'cloud-cache' ? 'cloud-cache' : 'other', updatedAt: typeof r.updated_at === 'number' ? new Date(r.updated_at).toISOString() : null, inReference: byKey.has(hash(`cursor:${r.id}`)) }));
      otherStores.push({ kind: 'conversation-search-cache', rows });
    }
    if (tables.has('cursorDiskKV')) otherStores.push({ kind: 'additional-state', composerRows: (db.prepare("SELECT count(*) n FROM cursorDiskKV WHERE key LIKE 'composerData:%'").get() as any).n, bubbleRows: (db.prepare("SELECT count(*) n FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'").get() as any).n, headers: tables.has('composerHeaders') ? (db.prepare('SELECT count(*) n FROM composerHeaders').get() as any).n : 0 });
  } catch { otherStores.push({ kind: 'unreadable-database' }); }
  finally { db?.close(); }
}
const composerDiffs: any[] = [];
const nativeComparison = native.composers.map((c: any) => {
  const ref: any = byKey.get(c.sessionKey);
  const afterCutoff = c.createdAt > cutoff || c.lastUpdatedAt > cutoff;
  const edits = [c.totalLinesAdded, c.totalLinesRemoved].some(value => typeof value === 'number' && Number.isFinite(value) && value > 0);
  const emptyDraft = c.isDraft === true && c.inlineBubbles === 0 && c.diskBubbles === 0 && c.reportedValueEntries === 0 && !edits;
  if (!afterCutoff) {
    if (emptyDraft && ref && !ref.evidence) composerDiffs.push({ sessionKey: c.sessionKey, field: 'emptyDraftIncluded' });
    if (!emptyDraft && !ref) composerDiffs.push({ sessionKey: c.sessionKey, field: 'missingComposer' });
    if (!emptyDraft && ref && !ref.evidence) {
      if (ref.cost.totalUsd !== c.costUsd || ref.cost.upperEstimateUsd !== c.costUsd) composerDiffs.push({ sessionKey: c.sessionKey, field: 'reportedCost' });
      if (ref.costComplete !== (c.reportedValueEntries > 0) || ref.costBasis !== (c.reportedValueEntries > 0 ? 'provider-reported' : 'unavailable')) composerDiffs.push({ sessionKey: c.sessionKey, field: 'reportedCostCoverage' });
    }
  }
  return { sessionKey: c.sessionKey, isDraft: c.isDraft, emptyDraft, afterCutoff, inReference: Boolean(ref), referenceCostComplete: ref?.costComplete, referenceCostBasis: ref?.costBasis };
});
const hierarchy = transcriptSessions.filter(s => s.executionKind === 'subagent').map(s => {
  const ref: any = byKey.get(s.sessionKey) ?? byKey.get(s.nativeSessionKey);
  return { sessionKey: s.sessionKey, parentSessionKey: s.parentSessionKey, referenceParentSessionKey: byKey.has(s.parentSessionKey) ? s.parentSessionKey : byKey.has(s.parentNativeSessionKey) ? s.parentNativeSessionKey : null, parentInReference: byKey.has(s.parentSessionKey) || byKey.has(s.parentNativeSessionKey), expectedExecutionKind: 'subagent', actualExecutionKind: ref?.executionKind ?? 'missing', source: ref?.evidence?.source ?? 'missing', inputTokens: ref?.tokens.inputTokens ?? 0, outputTokens: ref?.tokens.outputTokens ?? 0, apiBaseUsd: ref?.cost.totalUsd ?? 0, models: ref?.models.map((m: any) => m.model) ?? [], displayedMonthFromMtime: ref?.createdAt?.slice(0, 7) ?? null, userTurns: s.userTurns, assistantMessages: s.assistantMessages, toolCalls: s.toolCalls };
});
console.log(JSON.stringify({ cutoff: reference.generatedAt, native, tracking, otherStores, transcripts: { files: transcriptFiles.length, rows: transcriptSessions, aggregate: transcriptSessions.reduce((a, x) => { for (const k of ['userTurns', 'assistantMessages', 'toolCalls', 'records', 'malformedRecords', 'timestampFields', 'usageFields', 'modelFields']) add(a, k, x[k]); return a; }, {}), modifiedAfterCutoff: transcriptSessions.filter(x => x.fileModifiedAfterCutoff).length }, comparison: { referenceCursorSessions: referenceCursor.length, matchedTranscriptSessions: matched, suppressedBySdk, registeredKeyDifferences, nativeComparison, composerDiffs, hierarchy, timeFields, diffs } }, null, 2));
