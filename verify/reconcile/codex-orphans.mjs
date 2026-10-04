/** Match orphan Conductor numeric receipts against authoritative native rollout usage. */
import{readFileSync,writeFileSync,createReadStream}from'node:fs';import{join}from'node:path';import{homedir}from'node:os';import{DatabaseSync}from'../shared/sqlite.ts';import{createHash}from'node:crypto';import{createInterface}from'node:readline';
import { runPrivate, safeTimestamp, safeModel, safeCount, safeHash, safeRepositoryKey } from './codex-safe.mjs';

await runPrivate(async () => {
const source=JSON.parse(readFileSync('.lane/conductor-other-providers.json'));
const selected=source.sessions.filter(s=>s.provider==='codex'&&s.parentProvider==='orphan'&&!s.excludedLive);
const hash=s=>createHash('sha256').update(s).digest('hex').slice(0,12);
const db=new DatabaseSync(join(homedir(),'.codex','state_5.sqlite'),{readOnly:true});const native=db.prepare('SELECT id,rollout_path,tokens_used FROM threads').all();db.close();
const proofs=[];
for(const session of selected){safeHash(session.providerKey);safeHash(session.referenceSessionKey);const row=native.find(r=>hash('codex:'+r.id)===session.providerKey);if(!row){proofs.push({providerKey:session.providerKey,nativeDatabaseMatch:false});continue;}
 const states=[];for await(const line of createInterface({input:createReadStream(row.rollout_path),crlfDelay:Infinity})){if(!line.includes('"token_count"'))continue;let r;try{r=JSON.parse(line)}catch{continue}if(r.type!=='event_msg'||r.payload?.type!=='token_count')continue;const l=r.payload.info?.last_token_usage;if(l)states.push({timestamp:safeTimestamp(r.timestamp),input:safeCount(l.input_tokens),cached:safeCount(l.cached_input_tokens),output:safeCount(l.output_tokens),reasoning:safeCount(l.reasoning_output_tokens)});}
 const matches=session.receipts.map(r=>({receiptAt:safeTimestamp(r.at),input:r.usage.input_tokens,cached:r.usage.cache_read_input_tokens,output:r.usage.output_tokens,nativeMatches:states.filter(s=>s.input===r.usage.input_tokens&&s.cached===r.usage.cache_read_input_tokens&&s.output===r.usage.output_tokens)}));
 proofs.push({providerKey:session.providerKey,referenceSessionKey:session.referenceSessionKey,nativeDatabaseMatch:true,orphanReceipts:session.receipts.length,exactNativeReceiptMatches:matches.filter(m=>m.nativeMatches.length===1).length,receiptInput:session.rawUsageSums.input_tokens,receiptCached:session.rawUsageSums.cache_read_input_tokens,receiptOutput:session.rawUsageSums.output_tokens,receiptPhysicalTokens:session.rawUsageSums.input_tokens+session.rawUsageSums.output_tokens,nativeTotal:row.tokens_used,nativeRecordCount:states.length,matches});
}
writeFileSync('.lane/codex-orphan-proof.json',JSON.stringify({proofs},null,2)+'\n');console.log(JSON.stringify(proofs.map(({matches,...rest})=>rest),null,2));

});
