import './safe-failures.mjs';
/** Independent raw-usage oracle. Uses only Node builtins; never imports production code.
 * Source identities and paths exist in memory for matching and never enter output.
 * Authored from briefs before source inspection. The retained first-run artifacts
 * establish independence; post-diff corrections are explained in raw-findings.md.
 */
import { createReadStream, existsSync, readdirSync, realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from '../shared/sqlite.ts';

const home = homedir();
const reference = join(home, 'session-analytics-lanes/reference/snapshot-noindex-51ea561.json');
const cutoff = Date.parse((process.env.ORACLE_CUTOFF ?? '2026-10-03T12:17:26.745Z'));
const hash = x => createHash('sha256').update(x).digest('hex').slice(0, 12);
const n = x => Number.isFinite(x) && x >= 0 ? x : 0;
const instant = x => typeof x === 'string' && Number.isFinite(Date.parse(x)) ? Date.parse(x) : undefined;
const date = x => x === undefined ? null : new Date(x).toISOString();
const day = x => x === undefined ? 'undated' : new Date(x).toISOString().slice(0, 10);
const tokenNames = ['inputTokens','uncachedInputTokens','cachedInputTokens','cacheWriteInputTokens','cacheWrite5mInputTokens','cacheWrite1hInputTokens','outputTokens','reasoningOutputTokens','nonReasoningOutputTokens'];
const blank = () => Object.fromEntries(tokenNames.map(k => [k, 0]));
const add = (a,b) => { for (const k of tokenNames) a[k] += n(b[k]); return a; };
const delta = (a,b) => Object.fromEntries(tokenNames.map(k => [k, n(a[k]) - n(b[k])]));
const physical = t => t.inputTokens + t.outputTokens;
const modelName = x => typeof x === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(x) ? x : '<unknown>';
const stats = {files:{claude:0,codex:0},malformedLines:0,unreadableFiles:0,claudeUsageRecords:0,claudeRepeatedMessageIds:0,claudeMissingMessageIds:0,codexCounterRecords:0,codexRepeatedStates:0,codexOpeningBaselines:0,codexResetBaselines:0,codexMissingLastUsage:0,codexNewUsageRecords:0,conductorBindings:0};
const conductor = new Map(), databaseModels = new Map();
try {
  const db = new DatabaseSync(join(home,'Library/Application Support/com.conductor.app/conductor.db'),{readOnly:true});
  for (const row of db.prepare('SELECT id, claude_session_id AS provider_id, agent_type, model FROM sessions WHERE claude_session_id IS NOT NULL').all()) {
    const p = row.agent_type === 'codex' ? 'codex' : row.agent_type === 'claude' ? 'claude' : null;
    if (!p) continue;
    const key = `${p}:${row.provider_id}`;
    databaseModels.set(key,modelName(row.model));
    if (!conductor.has(key)) { conductor.set(key, hash(row.id)); stats.conductorBindings++; }
  }
  db.close();
} catch { stats.conductorUnavailable = true; }

const sessions = new Map();
function session(provider, id) {
  const identity = `${provider}:${id}`;
  if (!sessions.has(identity)) sessions.set(identity,{provider,sessionKey:conductor.get(identity) || hash(identity),first:undefined,last:undefined,requests:new Map(),files:0});
  return sessions.get(identity);
}
function observe(s,t) {
  if (t === undefined) return;
  s.first = s.first === undefined ? t : Math.min(t,s.first);
  s.last = s.last === undefined ? t : Math.max(t,s.last);
}
function roots(provider) {
  const candidates = readdirSync(home,{withFileTypes:true}).filter(e=>(e.isDirectory()||e.isSymbolicLink()) && (e.name === `.${provider}` || e.name.startsWith(`.${provider}-`))).map(e=>join(home,e.name));
  if (provider === 'claude') candidates.push(join(home,'.config/claude'), ...(process.env.CLAUDE_CONFIG_DIR ? [process.env.CLAUDE_CONFIG_DIR] : []));
  if (provider === 'codex' && process.env.CODEX_HOME) candidates.push(process.env.CODEX_HOME);
  return [...new Set(candidates.filter(existsSync).map(x=>realpathSync(x)))];
}
function walk(root) {
  const found = [], seen = new Set();
  function visit(dir) {
    let real; try { real = realpathSync(dir); } catch { return; }
    if (seen.has(real)) return; seen.add(real);
    let entries; try { entries = readdirSync(dir,{withFileTypes:true}); } catch { return; }
    for (const e of entries) { const p=join(dir,e.name); if(e.isDirectory()) visit(p); else if(e.isFile() && e.name.endsWith('.jsonl')) found.push(p); }
  }
  if (existsSync(root)) visit(root);
  return found.sort();
}
async function* records(file) {
  try {
    const lines=createInterface({input:createReadStream(file),crlfDelay:Infinity});
    for await(const line of lines) { if(!line.trim()) continue; try { yield JSON.parse(line); } catch {stats.malformedLines++;} }
  } catch { stats.unreadableFiles++; }
}
function claudeTokens(u) {
  const t=blank(); t.uncachedInputTokens=n(u.input_tokens); t.cachedInputTokens=n(u.cache_read_input_tokens);
  t.cacheWrite5mInputTokens=n(u.cache_creation?.ephemeral_5m_input_tokens);t.cacheWrite1hInputTokens=n(u.cache_creation?.ephemeral_1h_input_tokens);
  t.cacheWriteInputTokens=Math.max(n(u.cache_creation_input_tokens),t.cacheWrite5mInputTokens+t.cacheWrite1hInputTokens);
  t.inputTokens=t.uncachedInputTokens+t.cachedInputTokens+t.cacheWriteInputTokens;t.outputTokens=n(u.output_tokens);
  t.reasoningOutputTokens=Math.min(t.outputTokens,n(u.output_tokens_details?.thinking_tokens));t.nonReasoningOutputTokens=t.outputTokens-t.reasoningOutputTokens;return t;
}
function codexTokens(u) {
  const t=blank();t.inputTokens=n(u.input_tokens);t.cachedInputTokens=Math.min(t.inputTokens,n(u.cached_input_tokens));t.uncachedInputTokens=t.inputTokens-t.cachedInputTokens;
  t.outputTokens=n(u.output_tokens);t.reasoningOutputTokens=Math.min(t.outputTokens,n(u.reasoning_output_tokens));t.nonReasoningOutputTokens=t.outputTokens-t.reasoningOutputTokens;return t;
}

for (const root of roots('claude')) {
  for(const file of walk(join(root,'projects'))) {
    stats.files.claude++;
    // Main files have session IDs as basenames; subagent files belong to their enclosing session directory.
    // Shape probe found nested subagents/<directory>/<directory> evidence too.
    const subagentAt=file.indexOf('/subagents/');
    const id=subagentAt>=0 ? basename(file.slice(0,subagentAt)) : basename(file,'.jsonl');
    const s=session('claude',id);s.files++;
    for await(const r of records(file)) {
      const timestamp=instant(r.timestamp);observe(s,timestamp);
      const u=r.type==='assistant' && r.message?.usage;
      if(!u) continue;stats.claudeUsageRecords++;
      if(typeof r.message.id !== 'string') {stats.claudeMissingMessageIds++;continue;}
      const prior=s.requests.get(r.message.id),tokens=claudeTokens(u),reasoningExposed=typeof u.output_tokens_details?.thinking_tokens==='number';
      if(prior) {
        stats.claudeRepeatedMessageIds++;
        // Raw probes prove that early stream counters sometimes decrease when
        // final usage arrives. Never invent a request by mixing their maxima.
        if(tokens.outputTokens>prior.tokens.outputTokens||(tokens.outputTokens===prior.tokens.outputTokens&&physical(tokens)>0&&(physical(prior.tokens)===0||(reasoningExposed&&!prior.reasoningExposed)))) {
          prior.tokens=tokens;prior.reasoningExposed=reasoningExposed;prior.model=modelName(r.message.model);
        }
        if(timestamp!==undefined) {prior.first=Math.min(prior.first??timestamp,timestamp);prior.last=Math.max(prior.last??timestamp,timestamp);}
      } else s.requests.set(r.message.id,{requestKey:hash(`claude-message:${r.message.id}`),model:modelName(r.message.model),tokens,reasoningExposed,first:timestamp,last:timestamp,execution:subagentAt>=0?'subagent':'top-level'});
    }
  }
}
console.log(JSON.stringify({stage:'claude-complete',files:stats.files.claude,sessions:sessions.size}));

// Candidate ownership is computed only after every file has been observed.
const states = new Map();
for(const root of roots('codex')) {
  for(const subdir of ['sessions','archived_sessions']) for(const file of walk(join(root,subdir))) {
    stats.files.codex++; let s,model='<unknown>',previous,localActivity,execution='top-level',sequence=0;const models=new Set(),fileCandidates=[];
    for await(const r of records(file)) {
      sequence++;const t=instant(r.timestamp),p=r.payload;
      if(r.type==='session_meta' && typeof p?.id==='string') {
        // File identity is established once; resumed/forked metadata can carry
        // other IDs while updating the execution segment inside the same file.
        if(!s){s=session('codex',p.id);s.files++;model=databaseModels.get(`codex:${p.id}`)||model;}
        execution=typeof p.source==='object' && p.source?.subagent?'subagent':'top-level';
      }
      if(!s) continue;observe(s,t);
      if(r.type==='turn_context' && typeof p?.model==='string') {model=modelName(p.model);models.add(model);}
      // A local receipt/lifecycle event is also local activity. The first oracle
      // restricted this to response records; both are plausible interpretations
      // of the prose contract, so this correction follows the implemented policy.
      if(r.type!=='session_meta'&&r.type!=='turn_context'&&!(r.type==='event_msg'&&p?.type==='token_count')&&t!==undefined)localActivity=t;
      if(r.type==='event_msg' && p?.type==='token_usage_record') stats.codexNewUsageRecords++;
      if(r.type!=='event_msg'||p?.type!=='token_count'||!p.info?.total_token_usage) continue;
      stats.codexCounterRecords++;
      const total=codexTokens(p.info.total_token_usage),last=p.info.last_token_usage,hasLast=last && physical(codexTokens(last))>0;
      let tokens;
      if(hasLast) tokens=codexTokens(last);
      else {
        stats.codexMissingLastUsage++;
        if(!previous) stats.codexOpeningBaselines++;
        else if(total.inputTokens<previous.inputTokens||total.outputTokens<previous.outputTokens) stats.codexResetBaselines++;
        else tokens=Object.fromEntries(tokenNames.map(k=>[k,Math.max(0,total[k]-previous[k])]));
      }
      const signature=hasLast?[p.info.total_token_usage,last].flatMap(v=>['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens'].map(k=>n(v[k]))).join(':'):`${file}:${sequence}`; previous=total;
      if(!tokens||physical(tokens)===0) continue;
      const candidate={s,model,tokens,first:t,last:t,execution,file,sequence,distance:t!==undefined&&localActivity!==undefined&&localActivity<=t?t-localActivity:Number.POSITIVE_INFINITY};
      fileCandidates.push(candidate);
      const prior=states.get(signature);
      if(prior) {
        stats.codexRepeatedStates++;
        if(candidate.distance<prior.distance||(candidate.distance===prior.distance && ((t??Infinity)<(prior.first??Infinity)||((t??Infinity)===(prior.first??Infinity)&&file<prior.file)))) states.set(signature,candidate);
      } else states.set(signature,candidate);
    }
    if(models.size===1)for(const c of fileCandidates)if(c.model==='<unknown>')c.model=[...models][0];
    if(stats.files.codex%1000===0)console.log(JSON.stringify({stage:'codex-progress',files:stats.files.codex}));
  }
}
for(const [state,r] of states) r.s.requests.set(state,r);

// Persist the independently computed facts BEFORE opening the reference snapshot for numerical comparison.
const raw=[];
for(const s of sessions.values()) {
  const tokens=blank(),byDay=new Map(),byModel=new Map(),byMonth=new Map(),execution={'top-level':blank(),subagent:blank()};let crossingMidnight=0;
  const requests=[];
  for(const r of s.requests.values()) {
    if(physical(r.tokens)===0)continue;
    add(tokens,r.tokens);add(execution[r.execution],r.tokens);
    for(const [map,key] of [[byDay,day(r.last)],[byModel,r.model],[byMonth,day(r.last).slice(0,7)]]) {if(!map.has(key)) map.set(key,blank());add(map.get(key),r.tokens);}
    if(day(r.first)!==day(r.last))crossingMidnight++;
    requests.push({requestKey:r.requestKey??hash(`codex-request:${[...tokenNames.map(k=>r.tokens[k]),r.first].join(':')}`),model:r.model,firstAt:date(r.first),lastAt:date(r.last),tokens:r.tokens,execution:r.execution});
  }
  raw.push({sessionKey:s.sessionKey,provider:s.provider,files:s.files,firstEventAt:date(s.first),lastEventAt:date(s.last),lateActive:(s.last??0)>cutoff,tokens,requests:requests.length,crossingMidnight,byDay:Object.fromEntries(byDay),byMonth:Object.fromEntries(byMonth),byModel:Object.fromEntries(byModel),byExecution:execution,requestEvidence:requests});
}
raw.sort((a,b)=>a.sessionKey.localeCompare(b.sessionKey));
writeFileSync('.lane/raw-oracle-facts.json',JSON.stringify({oracleVersion:1,cutoff:date(cutoff),stats,sessions:raw},null,2));
console.log(JSON.stringify({stage:'independent-oracle-written',sessions:raw.length,stats}));

const snapshot=JSON.parse(readFileSync(reference,'utf8')), referenceMap=new Map(snapshot.sessions.map(s=>[s.sessionKey,s]));
const mismatches=[],matching=[],lateActive=[],missing=[];
for(const s of raw) {
  const ref=referenceMap.get(s.sessionKey);
  if(s.lateActive){lateActive.push({sessionKey:s.sessionKey,provider:s.provider,inReference:!!ref});continue;}
  if(!ref){missing.push({sessionKey:s.sessionKey,provider:s.provider,requests:s.requests,tokens:s.tokens});continue;}
  const difference=delta(s.tokens,ref.tokens);
  const modelDifferences=[];
  for(const model of new Set([...Object.keys(s.byModel),...ref.models.map(x=>x.model)])) {
    const d=delta(s.byModel[model]??blank(),ref.models.find(x=>x.model===model)??blank());
    if(Object.values(d).some(x=>x!==0))modelDifferences.push({model,delta:d});
  }
  if(Object.values(difference).some(x=>x!==0)||modelDifferences.length) mismatches.push({sessionKey:s.sessionKey,provider:s.provider,oracle:s.tokens,reference:ref.tokens,delta:difference,referenceUsd:ref.cost.totalUsd,referenceModelCalls:ref.metrics.modelCalls,oracleCalls:s.requests,models:modelDifferences});
  else matching.push({sessionKey:s.sessionKey,provider:s.provider,tokens:physical(s.tokens),referenceUsd:ref.cost.totalUsd});
}
const summary={rawSessions:raw.length,referenceSessions:snapshot.sessions.length,matchingSessions:matching.length,mismatchingSessions:mismatches.length,lateActiveSessions:lateActive.length,lateActiveInReference:lateActive.filter(x=>x.inReference).length,missingFromReference:missing.length,missingWithUsage:missing.filter(x=>physical(x.tokens)>0).length,referenceUnmatched:snapshot.sessions.filter(x=>!raw.some(s=>s.sessionKey===x.sessionKey)).length,byProvider:{}};
for(const provider of ['claude','codex']) summary.byProvider[provider]={matching:matching.filter(s=>s.provider===provider).length,mismatching:mismatches.filter(s=>s.provider===provider).length,delta:mismatches.filter(s=>s.provider===provider).reduce((a,s)=>{for(const k of tokenNames)a[k]+=s.delta[k];return a;},blank()),affectedReferenceUsd:mismatches.filter(s=>s.provider===provider).reduce((a,s)=>a+s.referenceUsd,0)};
writeFileSync('.lane/raw-oracle-results.json',JSON.stringify({oracleVersion:1,cutoff:date(cutoff),stats,summary,mismatches,matching,lateActive,missing},null,2));
console.log(JSON.stringify({stage:'reference-diff',summary}));
