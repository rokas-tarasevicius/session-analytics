// Independent paired-evidence oracle. No production parser or pricing imports.
// Raw identities/paths stay in memory; only public numeric projections are saved.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

export const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const number = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
const modelId = (v) => typeof v === 'string' && /^(claude|gpt)-[a-zA-Z0-9._-]{1,100}$/.test(v) ? v : '<unknown>';
const time = (v) => typeof v === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
export const classes = ['uncached', 'cacheRead', 'cacheWrite', 'write5m', 'write1h', 'output'];
export const zero = () => ({ uncached: 0, cacheRead: 0, cacheWrite: 0, write5m: 0, write1h: 0, output: 0, valueUsd: 0, requests: 0 });
export function usage(u = {}) {
  const write5m = number(u.cache_creation?.ephemeral_5m_input_tokens);
  const write1h = number(u.cache_creation?.ephemeral_1h_input_tokens);
  return { uncached: number(u.input_tokens ?? u.inputTokens), cacheRead: number(u.cache_read_input_tokens ?? u.cacheReadInputTokens),
    cacheWrite: Math.max(number(u.cache_creation_input_tokens ?? u.cacheCreationInputTokens), write5m + write1h),
    write5m, write1h, output: number(u.output_tokens ?? u.outputTokens) };
}
export function add(a, b) { for (const k of Object.keys(a)) a[k] += number(b[k]); return a; }
export function value(u, model, rates) {
  const key = Object.keys(rates.models).filter(k => model === k || model.startsWith(k + '-')).sort((a,b) => b.length-a.length)[0];
  const r = rates.models[key]; if (!r) return 0;
  const large = r.longContext && u.uncached + u.cacheRead + u.cacheWrite > r.longContext.thresholdInputTokens;
  const inputFactor = large ? r.longContext.inputMultiplier : 1;
  return ((u.uncached * r.inputPerMillion + u.cacheRead * (r.cacheReadPerMillion ?? r.cachedInputPerMillion ?? 0)
    + (u.cacheWrite - u.write1h) * (r.cacheWrite5mPerMillion ?? r.inputPerMillion * (r.cacheWriteMultiplier ?? 1))
    + u.write1h * (r.cacheWrite1hPerMillion ?? r.inputPerMillion * 2)) * inputFactor
    + u.output * r.outputPerMillion * (large ? r.longContext.outputMultiplier : 1)) / 1e6;
}
async function* lines(file) {
  let tail = '';
  for await (const chunk of createReadStream(file, { encoding: 'utf8' })) {
    const rows = (tail + chunk).split('\n'); tail = rows.pop();
    yield* rows;
  }
  if (tail) yield tail;
}
async function entries(p) { try { return await readdir(p, { withFileTypes: true }); } catch { return []; } }
async function childFiles(root) {
  const paths = [];
  for (const e of await entries(root)) {
    if (e.isDirectory()) paths.push(...await childFiles(join(root,e.name)));
    else if (e.isFile() && e.name.endsWith('.jsonl')) paths.push(join(root,e.name));
  }
  return paths;
}
export async function discover() {
  const db = new DatabaseSync(join(homedir(), 'Library/Application Support/com.conductor.app/conductor.db'), { readOnly: true });
  const sessions = db.prepare("SELECT id, claude_session_id, created_at, updated_at, status FROM sessions WHERE agent_type = 'claude'").all();
  const wanted = new Map(sessions.map(s => [s.claude_session_id, s]));
  for (const profile of (await entries(homedir())).filter(e => e.isDirectory() && /^\.claude(?:$|-)/.test(e.name))) {
    const projects = join(homedir(), profile.name, 'projects');
    for (const project of (await entries(projects)).filter(e => e.isDirectory())) {
      const dir = join(projects, project.name);
      for (const file of (await entries(dir)).filter(e => e.isFile() && e.name.endsWith('.jsonl'))) {
        const session = wanted.get(file.name.slice(0, -6)); if (!session) continue;
        session.files ??= []; session.files.push(join(dir, file.name));
        const children = join(dir, file.name.slice(0, -6), 'subagents');
        session.files.push(...await childFiles(children));
      }
    }
  }
  return { db, sessions };
}
export async function nativeOracle(session, rates) {
  const requests = new Map(); let latest = null; let malformed = 0; let iterations = 0;
  for (const file of session.files ?? []) {
    const child = file.includes('/subagents/');
    for await (const line of lines(file)) {
      if (!line) continue; let v; try { v = JSON.parse(line); } catch { malformed++; continue; }
      if (!child && v.sessionId && v.sessionId !== session.claude_session_id) continue;
      const timestamp = time(v.timestamp); if (timestamp && (!latest || timestamp > latest)) latest = timestamp;
      if (v.type !== 'assistant' || !v.message?.usage || (!child && v.isSidechain)) continue;
      if (v.isApiErrorMessage || v.message.model === '<synthetic>') continue;
      const m = v.message; const id = m.id ?? v.requestId; if (!id) continue;
      const u = usage(m.usage); const old = requests.get(id);
      if (old && old.usage.output > u.output) continue;
      if (old && old.usage.output === u.output) { old.usage.write1h = Math.max(old.usage.write1h, u.write1h); old.usage.write5m = Math.max(old.usage.write5m, u.write5m); continue; }
      // A singleton message iteration can retain the early executor snapshot
      // while the envelope has the finalized response. Multi-attempt arrays
      // establish additional billed attempts; singleton mirrors do not.
      const rawParts = m.usage.iterations;
      const parts = Array.isArray(rawParts) && rawParts.length && !(rawParts.length === 1 && rawParts[0]?.type === 'message') ? rawParts : null;
      if (parts) iterations++;
      requests.set(id, { model: modelId(m.model), usage: u, timestamp: old?.timestamp ?? timestamp, child, parts });
    }
  }
  const totals = zero(), main = zero(), models = {}, days = {}; let childRequests = 0;
  for (const r of requests.values()) {
    const pieces = r.parts ? r.parts.filter(x => x && typeof x === 'object').map(x => ({ model: modelId(x.model ?? r.model), usage: usage(x) })) : [r];
    for (const piece of pieces) {
      const u = { ...piece.usage, valueUsd: value(piece.usage, piece.model, rates), requests: 1 };
      add(totals, u); if (!r.child) add(main, u); add(models[piece.model] ??= zero(), u);
      const day = r.timestamp?.slice(0, 10) ?? 'undated'; add(days[day] ??= zero(), u);
      if (r.child) childRequests++;
    }
  }
  return { totals, main, models, days, latest, malformed, iterations, childRequests };
}
// Project metadata at the SQLite boundary. Never select SDK text/content blocks.
export function* sdkRecords(db, id) {
  for (const row of db.prepare(`SELECT id, created_at, sent_at, sdk_message_id, turn_id,
    json_extract(content, '$.type') AS type, json_extract(content, '$.subtype') AS subtype,
    json_extract(content, '$.uuid') AS uuid, json_extract(content, '$.session_id') AS provider_id,
    json_extract(content, '$.parent_tool_use_id') AS parent,
    json_extract(content, '$.message.id') AS response_id, json_extract(content, '$.message.model') AS model,
    json_extract(content, '$.message.usage') AS message_usage,
    json_extract(content, '$.usage') AS result_usage, json_extract(content, '$.modelUsage') AS model_usage,
    json_extract(content, '$.total_cost_usd') AS cost, json_extract(content, '$.timestamp') AS timestamp,
    json_extract(content, '$.claude_code_version') AS version
    FROM session_messages WHERE session_id = ? AND json_valid(content) ORDER BY rowid`).iterate(id)) {
    yield { ...row, message_usage: row.message_usage ? JSON.parse(row.message_usage) : null,
      result_usage: row.result_usage ? JSON.parse(row.result_usage) : null,
      model_usage: row.model_usage ? JSON.parse(row.model_usage) : null };
  }
}
export function sdkOracle(records, session, rates) {
  const groups = new Map(), seen = new Set(), results = []; let assistantRows = 0, identified = 0, init = 0;
  let stream = zero();
  for (const r of records) {
    if (r.provider_id && r.provider_id !== session.claude_session_id) continue;
    const id = r.uuid ?? r.id; if (seen.has(id)) continue; seen.add(id);
    if (r.type === 'system' && r.subtype === 'init') init++;
    if (r.type === 'assistant' && r.message_usage) {
      assistantRows++; const u = usage(r.message_usage), model = modelId(r.model); add(stream, { ...u, valueUsd: value(u,model,rates), requests:1 });
      if (r.response_id) identified++;
      const key = r.response_id ?? JSON.stringify([r.provider_id,r.parent,model,u.uncached,u.cacheRead,u.cacheWrite]);
      const old = groups.get(key); if (!old || old.usage.output < u.output) groups.set(key, { model,usage:u, child:!!r.parent });
    }
    if (r.type === 'result') results.push(r);
  }
  const grouped = zero(), mainGrouped = zero(), mainModels = new Set();
  for (const r of groups.values()) { const u = { ...r.usage,valueUsd:value(r.usage,r.model,rates),requests:1 }; add(grouped, u); if (!r.child) { add(mainGrouped, u); mainModels.add(r.model); } }
  const queryUsage = zero(), modelMax = {}, receiptMax = zero(); let reportedUsd = 0;
  for (const r of results) {
    if (r.result_usage) add(queryUsage,usage(r.result_usage));
    reportedUsd = Math.max(reportedUsd,number(r.cost));
    for (const [name,v] of Object.entries(r.model_usage ?? {})) {
      const model = modelId(name), u = usage(v), target = modelMax[model] ??= zero();
      for (const k of classes) target[k] = Math.max(target[k],u[k]);
    }
  }
  for (const [model,u] of Object.entries(modelMax)) { u.valueUsd=value(u,model,rates); add(receiptMax,u); }
  return { assistantRows,identified,init,results:results.length,stream,grouped,mainGrouped,mainModels:[...mainModels],queryUsage,receiptMax,reportedUsd,modelMax };
}
export async function runOracle(out = '.lane/recovery-oracle.json') {
  const rates = JSON.parse(await readFile(new URL('../../data/rate-cards.json',import.meta.url),'utf8'));
  const { db,sessions } = await discover(); const pairs = []; const cutoff = new Date().toISOString();
  try {
    for (const s of sessions.filter(s => s.files?.length)) {
      const sdk = sdkOracle(sdkRecords(db,s.id),s,rates); if (!sdk.assistantRows && !sdk.results) continue;
      const native = await nativeOracle(s,rates);
      pairs.push({ sessionKey:hash(s.id),native,sdk,settled:!native.latest || native.latest < cutoff });
    }
  } finally { db.close(); }
  const result = { version:1,cutoff,registeredSessions:sessions.length,pairedSessions:pairs.length,pairs };
  await mkdir(new URL('../../.lane/',import.meta.url),{recursive:true});
  await writeFile(out,JSON.stringify(result,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({version:1,pairedSessions:pairs.length,registeredSessions:sessions.length}));
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runOracle(process.argv[2]); } catch { console.error('Recovery oracle failed; raw error suppressed.'); process.exitCode=1; }
}
