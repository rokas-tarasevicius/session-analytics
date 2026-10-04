#!/usr/bin/env node
// Optional read-only WAL-aware freshness check. The primary oracle also uses the independent guarded WAL-aware reader.
import {createHash} from 'node:crypto';
import{readFileSync,readdirSync,realpathSync,writeFileSync}from'node:fs';
import{homedir}from'node:os';import{join}from'node:path';import{pathToFileURL}from'node:url';import{spawnSync}from'node:child_process';
const hash=s=>createHash('sha256').update(s).digest('hex').slice(0,12);
const oracle=JSON.parse(readFileSync('.lane/codex-db-oracle.json','utf8'));
const old=new Map(oracle.threads.map(r=>[r.threadKey,r]));
const roots=new Set(readdirSync(homedir()).filter(n=>/^\.codex(?:-|$)/.test(n)).map(n=>realpathSync(join(homedir(),n))));
const summary={stableCompared:0,stableCounterChangesSinceImmutableRead:0,liveOrNew:0,liveOrNewTokenDelta:0};
const changed=[];
for(const home of roots)for(const name of readdirSync(home).filter(n=>/^state_\d+\.sqlite$/.test(n))){
 const uri=pathToFileURL(join(home,name));uri.search='mode=ro';
 const result=spawnSync('/usr/bin/sqlite3',['-readonly','-json',uri.href,'SELECT id,tokens_used,updated_at,updated_at_ms FROM threads'],{encoding:'utf8',maxBuffer:64*1024*1024});
 if(result.status!==0)throw new Error('Read-only WAL-aware SQLite query failed');
 for(const row of JSON.parse(result.stdout)){const key=hash(`codex:${row.id}`);const prior=old.get(key);const afterCutoff=(row.updated_at_ms||row.updated_at*1000)>Date.parse(oracle.referenceGeneratedAt);
  if(!prior||prior.afterCutoff||afterCutoff){summary.liveOrNew++;summary.liveOrNewTokenDelta+=row.tokens_used-(prior?.tokensUsed||0);continue;}
  summary.stableCompared++;if(prior.tokensUsed!==row.tokens_used){summary.stableCounterChangesSinceImmutableRead++;changed.push({threadKey:key,immutableTokens:prior.tokensUsed,walAwareTokens:row.tokens_used});}
 }
}
writeFileSync('.lane/codex-db-wal-check.json',`${JSON.stringify({referenceGeneratedAt:oracle.referenceGeneratedAt,summary,changed},null,2)}\n`);
console.log(JSON.stringify(summary,null,2));
