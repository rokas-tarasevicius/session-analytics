/** Compare native thread counters with legacy states without assuming they share a baseline. */
import {readFileSync,writeFileSync} from 'node:fs';
process.on('uncaughtException', () => { process.stderr.write('Time validation failed; local details suppressed.\n'); process.exit(1); });
const native=JSON.parse(readFileSync('.lane/time-native-codex-audit.json','utf8'));
const legacy=JSON.parse(readFileSync('.lane/codex-observations.json','utf8'));
const tuple=(u:any)=>[u.inputTokens,u.cachedInputTokens,u.outputTokens,u.reasoningOutputTokens];
const states=new Map<string,any[]>(),localUsage=new Map<string,any[]>();
for(const row of legacy.observations){for(const [map,key]of [[states,JSON.stringify([tuple(row.total),tuple(row.last)])],[localUsage,JSON.stringify([row.sessionKey,tuple(row.last)])]] as [Map<string,any[]>,string][]){const group=map.get(key)??[];group.push(row);map.set(key,group);}}
const zero=()=>({records:0,globalStateMatch:0,localStateMatch:0,nearLocalStateMatch:0,nearLocalLastUsageMatch:0,stateMismatchButNearLastUsageMatch:0});
const counts={normal:zero(),compaction:zero()};const exampleRows:any[]=[];
for(const row of native.native){const count=counts[row.compactionResponse?'compaction':'normal'];count.records++;const global=states.get(JSON.stringify([row.threadUsage,row.usage]))??[];const own=global.filter(r=>r.sessionKey===row.sessionKey);const near=own.filter(r=>Math.abs(Date.parse(r.time)-Date.parse(row.time))<30000);const usage=(localUsage.get(JSON.stringify([row.sessionKey,row.usage]))??[]).filter(r=>Math.abs(Date.parse(r.time)-Date.parse(row.time))<30000);if(global.length)count.globalStateMatch++;if(own.length)count.localStateMatch++;if(near.length)count.nearLocalStateMatch++;if(usage.length)count.nearLocalLastUsageMatch++;if(!global.length&&usage.length){count.stateMismatchButNearLastUsageMatch++;if(exampleRows.length<3)exampleRows.push({sessionKey:row.sessionKey,responseKey:row.responseKey,nativeTime:row.time,legacyTime:usage[0].time,usage:row.usage,nativeThreadUsage:row.threadUsage,legacyTotalUsage:tuple(usage[0].total)});}}
const result={counts,exampleRows};writeFileSync('.lane/time-native-codex-state-matches.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
