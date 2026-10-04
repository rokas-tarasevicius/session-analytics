/** Independent Codex aggregate oracle. No imports from application source.
 * Reads provider stores only; emitted evidence contains counters and hashed identities.
 * First run --raw-only before inspecting the reference/analyzer.
 */
import { createReadStream, existsSync, readdirSync, realpathSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from '../shared/sqlite.ts';

import { runPrivate, safeTimestamp, safeModel, safeCount, safeHash, safeRepositoryKey } from './codex-safe.mjs';

await runPrivate(async () => {
const cutoff = (process.env.ORACLE_CUTOFF ?? '2026-10-03T12:17:26.745Z');
const cutoffMs = Date.parse(cutoff);
const hash = value => createHash('sha256').update(String(value)).digest('hex').slice(0,12);
const safeNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
const month = value => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString().slice(0,7) : 'undated';
const iso = value => Number.isFinite(value) ? new Date(value).toISOString() : null;
const totals = () => ({ input:0, cached:0, output:0, reasoning:0, total:0 });
const usage = obj => ({input:safeNumber(obj?.input_tokens),cached:safeNumber(obj?.cached_input_tokens),output:safeNumber(obj?.output_tokens),reasoning:safeNumber(obj?.reasoning_output_tokens),total:safeNumber(obj?.total_tokens)});
const add = (target, source) => { for (const k of ['input','cached','output','reasoning','total']) target[k] += source[k] || 0; };
const inode = path => {const s=statSync(path); return `${s.dev}:${s.ino}`;};
const profileAliases = new Map();
for (const name of readdirSync(homedir()).filter(name=>name.startsWith('.codex'))) {
  const path = join(homedir(),name);
  if (!existsSync(join(path,'state_5.sqlite')) && !existsSync(join(path,'history.jsonl'))) continue;
  const real = realpathSync(path);
  const row = profileAliases.get(real) ?? {path:real, profileKey:hash(`codex-profile:${real}`), aliases:[]};
  row.aliases.push(hash(`profile-alias:${name}`)); profileAliases.set(real,row);
}
const identity = new Map();
const conductorDb = join(homedir(),'Library','Application Support','com.conductor.app','conductor.db');
if (existsSync(conductorDb)) {
  const db = new DatabaseSync(conductorDb,{readOnly:true});
  for (const row of db.prepare("SELECT id, claude_session_id FROM sessions WHERE agent_type = 'codex'").all()) {
    if (row.claude_session_id) identity.set(row.claude_session_id,hash(row.id));
  }
  db.close();
}
const keyFor = id => identity.get(id) ?? hash(`codex:${id}`);
const dbRows = new Map();
const profiles = [];
const seenDb = new Set(), seenHistory = new Set(), seenFiles = new Set();
const historySessions = new Map();
for (const p of profileAliases.values()) {
  const info = {profileKey:p.profileKey,aliases:p.aliases,threads:0,tokensUsedSum:0,excludedAfterCutoff:0,excludedAfterCutoffTokens:0,historyRecords:0,historySessions:0,historyMalformed:0,historyAfterCutoff:0,historyMonths:{},threadStartMonths:{}};
  const dbPath = join(p.path,'state_5.sqlite');
  if (existsSync(dbPath) && !seenDb.has(inode(dbPath))) {
    seenDb.add(inode(dbPath));
    const db = new DatabaseSync(dbPath,{readOnly:true});
    for (const row of db.prepare('SELECT id, tokens_used, created_at, updated_at, created_at_ms, updated_at_ms, rollout_path, archived, cwd, model FROM threads').all()) {
      const updatedAt = row.updated_at_ms || row.updated_at*1000;
      const createdAt = row.created_at_ms || row.created_at*1000;
      const item = {sessionKey:keyFor(row.id),providerKey:hash(`codex:${row.id}`),profileKey:p.profileKey,repoHash:hash(`repo:${row.cwd}`),tokensUsed:safeNumber(row.tokens_used),createdAt:iso(createdAt),updatedAt:iso(updatedAt),afterCutoff:updatedAt>cutoffMs,rolloutPresent:existsSync(row.rollout_path),archived:!!row.archived};
      dbRows.set(row.id,item);
      info.threads++; info.tokensUsedSum += item.tokensUsed;
      if(item.afterCutoff){info.excludedAfterCutoff++;info.excludedAfterCutoffTokens+=item.tokensUsed;}
      else {const m=month(item.createdAt); const bucket=info.threadStartMonths[m]??={sessions:0,tokensUsedSum:0};bucket.sessions++;bucket.tokensUsedSum+=item.tokensUsed;}
    }
    db.close();
  }
  const historyPath=join(p.path,'history.jsonl');
  const localHistorySessions=new Set();
  if(existsSync(historyPath)&&!seenHistory.has(inode(historyPath))){
    seenHistory.add(inode(historyPath));
    for await(const line of createInterface({input:createReadStream(historyPath),crlfDelay:Infinity})){
      if(!line.trim())continue;
      let r;try{r=JSON.parse(line)}catch{info.historyMalformed++;continue;}
      const timestamp=typeof r.ts==='number'?r.ts*1000:Date.parse(r.ts);
      if(timestamp>cutoffMs){info.historyAfterCutoff++;continue;}
      const m=Number.isFinite(timestamp)?month(iso(timestamp)):'undated';
      const bucket=info.historyMonths[m]??={records:0,sessions:0};bucket.records++;
      info.historyRecords++;
      if(typeof r.session_id==='string'){
        const key=keyFor(r.session_id);localHistorySessions.add(key);
        const existing=historySessions.get(key)??{sessionKey:key,profileKey:p.profileKey,records:0,months:new Set()};
        if(!existing.months.has(m)){bucket.sessions++;existing.months.add(m)}existing.records++;historySessions.set(key,existing);
      }
    }
  }
  info.historySessions=localHistorySessions.size;profiles.push(info);
}
const rollouts=[];
function walk(path,profileKey){if(!existsSync(path))return;for(const e of readdirSync(path,{withFileTypes:true})){const f=join(path,e.name);if(e.isDirectory())walk(f,profileKey);else if(e.isFile()&&e.name.endsWith('.jsonl')){const id=inode(f);if(seenFiles.has(id))continue;seenFiles.add(id);rollouts.push({path:f,profileKey})}}}
for(const p of profileAliases.values())for(const kind of ['sessions','archived_sessions'])walk(join(p.path,kind),p.profileKey);
const globalStates=new Map();
const fileRows=[];
let scanned=0;
for(const f of rollouts){
  let id=null, firstAt=null,lastAt=null,lastTotal=null,maxTotal=0,tokenRecords=0,newUsageRecords=0,malformed=0,resets=0,priorTotal=null,metadataRecords=0,forked=false;
  const localStates=new Map(), cumulativeMonths={};const newUsageNumeric={},newUsageShapes={};
  for await(const line of createInterface({input:createReadStream(f.path),crlfDelay:Infinity})){
    if(!line.trim())continue;
    let r;try{r=JSON.parse(line)}catch{malformed++;continue;}
    const time=Date.parse(safeTimestamp(r.timestamp));
    if(Number.isFinite(time)){if(firstAt===null||time<firstAt)firstAt=time;if(lastAt===null||time>lastAt)lastAt=time;}
    if(r.type==='session_meta') {metadataRecords++;if(!id)id=r.payload?.id;forked ||= typeof r.payload?.forked_from_id==='string';}
    if(r.type!=='event_msg')continue;
    const p=r.payload;
    if(p?.type==='token_usage_record'){
      newUsageRecords++;
      function numbers(obj,prefix='',depth=0){if(!obj||typeof obj!=='object'||depth>4)return;for(const [k,v] of Object.entries(obj)){if(['input_tokens','cached_input_tokens','cache_read_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'].includes(k)&&typeof v==='number')newUsageNumeric[prefix+k]=(newUsageNumeric[prefix+k]??0)+v;else if(['usage','token_usage','info','total_token_usage','last_token_usage','record'].includes(k))numbers(v,prefix+k+'.',depth+1)}}
      numbers(p);
      for(const k of ['usage','token_usage','info','total_token_usage','last_token_usage','record'])if(p[k])newUsageShapes[k]=(newUsageShapes[k]??0)+1;
    }
    if(p?.type!=='token_count'||!p.info?.total_token_usage)continue;
    tokenRecords++;
    const total=usage(p.info.total_token_usage),last=usage(p.info.last_token_usage);
    if(priorTotal!==null&&total.total<priorTotal)resets++;priorTotal=total.total;
    lastTotal=total;maxTotal=Math.max(maxTotal,total.total);
    const m=month(safeTimestamp(r.timestamp));const mb=cumulativeMonths[m]??={observations:0,first:total.total,last:0,max:0};mb.observations++;mb.last=total.total;mb.max=Math.max(mb.max,total.total);
    const state=JSON.stringify([total,last]);
    if(!localStates.has(state))localStates.set(state,{total,last,timestamp:Number.isFinite(time)?iso(time):null});
  }
  if(!id) { const match=basename(f.path).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);id=match?.[1]??`unknown:${hash(f.path)}`; }
  const db=dbRows.get(id);const sessionKey=keyFor(id);
  const afterCutoff=lastAt>cutoffMs||db?.afterCutoff===true;
  const rawLastUsage=totals();for(const s of localStates.values())add(rawLastUsage,s.last);
  const row={sessionKey,providerKey:hash(`codex:${id}`),profileKey:f.profileKey,firstAt:iso(firstAt),lastAt:iso(lastAt),afterCutoff,dbTokensUsed:db?.tokensUsed??null,tokenRecords,uniqueStates:localStates.size,newUsageRecords,newUsageNumeric,newUsageShapes,malformed,resets,metadataRecords,forked,lastTotal,maxTotal,rawLastUsage,cumulativeMonths};
  fileRows.push(row);
  if(!afterCutoff){for(const[state,s]of localStates){const existing=globalStates.get(state);if(existing){existing.observers.add(sessionKey);if(s.timestamp&&(!existing.timestamp||s.timestamp<existing.timestamp))existing.timestamp=s.timestamp;}else globalStates.set(state,{...s,observers:new Set([sessionKey])});}}
  scanned++;if(scanned%500===0)process.stderr.write(JSON.stringify({progressFiles:scanned,totalFiles:rollouts.length})+'\n');
}
const stateMonths={},globalLastUsage=totals();let sharedStates=0,unusableLastStates=0;
for(const s of globalStates.values()) {const m=month(s.timestamp);const bucket=stateMonths[m]??={states:0,sharedStates:0,tokens:totals()};bucket.states++;add(bucket.tokens,s.last);add(globalLastUsage,s.last);if(s.observers.size>1){sharedStates++;bucket.sharedStates++;}if(s.last.input+s.last.output===0)unusableLastStates++;}
const settledFiles=fileRows.filter(r=>!r.afterCutoff),settledDb=[...dbRows.values()].filter(r=>!r.afterCutoff);
const equal=settledFiles.filter(r=>r.dbTokensUsed!==null&&r.lastTotal&&r.dbTokensUsed===r.lastTotal.total);
const raw={cutoff,computedAt:new Date().toISOString(),profiles,coverage:{files:fileRows.length,settledFiles:settledFiles.length,excludedFiles:fileRows.length-settledFiles.length,threads:dbRows.size,settledThreads:settledDb.length,uniqueGlobalStates:globalStates.size,sharedStates,unusableLastStates,dbExactlyLastCumulative:equal.length},globalLastUsage,stateMonths,dbRows:[...dbRows.values()],historySessions:[...historySessions.values()].map(r=>({...r,months:[...r.months]})),fileRows};
writeFileSync('.lane/codex-raw-oracle.json',JSON.stringify(raw,null,2)+'\n');
console.log(JSON.stringify({stage:'raw-oracle',coverage:raw.coverage,globalLastUsage,stateMonths}));
if(!process.argv.includes('--raw-only'))console.log('Raw oracle written; run verify/reconcile/codex-diff.mjs separately to compare the reference.');

});
