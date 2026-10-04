/** Independent reconciliation of explicit Codex response usage absent from token snapshots. */
import { readFileSync,writeFileSync,readdirSync,existsSync,realpathSync,statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from '../shared/sqlite.ts';
process.on('uncaughtException',()=>{process.stderr.write('Native response verification failed; local details suppressed.\n');process.exit(1);});
const hash=(s:string)=>createHash('sha256').update(s).digest('hex').slice(0,12),h=homedir();
const raw=JSON.parse(readFileSync('.lane/codex-observations.json','utf8')),reconciliation=JSON.parse(readFileSync('.lane/codex-reconciliation.json','utf8'));
const rates=JSON.parse(readFileSync('data/rate-cards.json','utf8')).models;
const bySession=new Map<string,Set<string>>();for(const o of raw.observations){if(!bySession.has(o.sessionKey))bySession.set(o.sessionKey,new Set());bySession.get(o.sessionKey)!.add(JSON.stringify(o.last));}
const stable=new Set(reconciliation.requestComparison.map((r:any)=>r.sessionKey));
const missing=new Map<string,any>();for(const r of raw.requestRecords)if(stable.has(r.sessionKey)&&!bySession.get(r.sessionKey)?.has(JSON.stringify(r.usage)))missing.set(r.responseKey,r);
const conductor=new DatabaseSync(join(h,'Library/Application Support/com.conductor.app/conductor.db'),{readOnly:true});
const registrations=new Map((conductor.prepare("SELECT id,claude_session_id FROM sessions WHERE agent_type='codex'").all() as any[]).filter(r=>r.claude_session_id).map(r=>[r.claude_session_id,hash(r.id)]));conductor.close();
const native=new DatabaseSync(join(h,'.codex/state_5.sqlite'),{readOnly:true});const ids=new Map<string,string>();const nativePaths:string[]=[];
for(const r of native.prepare('SELECT id,rollout_path FROM threads').all() as any[]){const key=registrations.get(r.id)??hash(`codex:${r.id}`);if([...missing.values()].some(m=>m.sessionKey===key)){ids.set(r.id,key);nativePaths.push(r.rollout_path);}}native.close();
const paths:string[]=[...nativePaths],roots=new Set<string>();function walk(p:string){for(const d of readdirSync(p,{withFileTypes:true})){const q=join(p,d.name);if(d.isDirectory())walk(q);else if([...ids.keys()].some(id=>d.name.endsWith(`${id}.jsonl`)))paths.push(q);}}
for(const p of readdirSync(h,{withFileTypes:true}).filter(d=>d.name==='.codex'||d.name.startsWith('.codex-')).map(d=>join(h,d.name)))for(const suffix of ['sessions','archived_sessions']){const p2=join(p,suffix);if(existsSync(p2)){const root=realpathSync(p2);if(!roots.has(root)){roots.add(root);walk(root);}}}
const found=new Map<string,any>();
for(const path of new Set(paths)){let model='<unknown>',containerId:string|null=null;const compacted=new Set<string>();const local:any[]=[];for(const line of readFileSync(path,'utf8').split('\n')){if(!line.trim())continue;let r;try{r=JSON.parse(line)}catch{continue;}const p=r.payload??{};if(r.type==='session_meta'&&typeof p.id==='string')containerId??=p.id;if(r.type==='turn_context'&&typeof p.model==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(p.model))model=p.model;if(r.type==='compacted'&&typeof p.compaction_response_id==='string')compacted.add(hash(p.compaction_response_id));if(r.type!=='token_usage_record'||typeof p.response_id!=='string')continue;const key=hash(p.response_id),target=missing.get(key);if(!target)continue;const rate=rates[model],u=target.usage;const long=rate?.longContext&&u.inputTokens>rate.longContext.thresholdInputTokens;const valueUsd=rate?((u.inputTokens-u.cachedInputTokens)*rate.inputPerMillion*(long?rate.longContext.inputMultiplier:1)+u.cachedInputTokens*rate.cachedInputPerMillion*(long?rate.longContext.inputMultiplier:1)+u.outputTokens*rate.outputPerMillion*(long?rate.longContext.outputMultiplier:1))/1e6:0;local.push({...target,model,valueUsd,threadMatchesContainer:p.thread_id===containerId,sourceExistedBeforeReference:statSync(path).birthtime.toISOString()<raw.referenceTime&&statSync(path).mtime.toISOString()<raw.referenceTime});}
for(const r of local)found.set(r.responseKey,{...r,compactionResponse:compacted.has(r.responseKey)});}
const rows=[...found.values()];const months:any={},models:any={};for(const r of rows){for(const [dest,key]of[[months,r.time.slice(0,7)],[models,r.model]] as const){const b=dest[key]??={requests:0,inputTokens:0,outputTokens:0,valueUsd:0};b.requests++;b.inputTokens+=r.usage.inputTokens;b.outputTokens+=r.usage.outputTokens;b.valueUsd+=r.valueUsd;}}
const result={missingCandidates:missing.size,confirmed:rows.length,sessions:new Set(rows.map(r=>r.sessionKey)).size,compactionResponses:rows.filter(r=>r.compactionResponse).length,nativeOwnersMatch:rows.every(r=>r.threadMatchesContainer),sourcesExistedBeforeReference:rows.every(r=>r.sourceExistedBeforeReference),months,models,rows};
writeFileSync('.lane/codex-native-audit.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({...result,rows:undefined},null,2));
