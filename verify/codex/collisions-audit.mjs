// Receipt identity audit catches equal numeric counters that are distinct requests.
import {readFile,writeFile} from 'node:fs/promises';
import {priceUsage} from './pricing-oracle.mjs';
const read=async p=>JSON.parse(await readFile(p,'utf8'));
const [raw,control,receiptAudit,map]=await Promise.all([read('.lane/codex-observations.json'),read('.lane/codex-source-control.json'),read('.lane/codex-receipts-audit.json'),read('.lane/codex-key-map.json')]);
const live=new Set(raw.sessions.filter(s=>s.live).map(s=>s.key));
const knownMissing=new Set(receiptAudit.missing.map(r=>r.responseKey));
const original=new Map(raw.observations.filter(o=>o.kind==='legacy').map(o=>[o.key+':'+o.signature+':'+o.at,o]));
const counted=new Map();for(const q of control.requests){const o=original.get(q.key+':'+q.signature+':'+q.at);const k=q.key+':'+JSON.stringify(q.u);counted.set(k,(counted.get(k)??0)+1)}
const uncovered=[];const seen=new Set();
for(const o of raw.observations){if(o.kind!=='response'||live.has(o.key))continue;const id=o.key+':'+o.response;if(seen.has(id))continue;seen.add(id);const k=o.key+':'+JSON.stringify(o.u),n=counted.get(k)??0;if(n){counted.set(k,n-1);continue}if(knownMissing.has(o.response))continue;
 const p=priceUsage(o.model,{input_tokens:o.u[0],cached_input_tokens:o.u[1],output_tokens:o.u[2],reasoning_output_tokens:o.u[3]},{timestamp:o.at,requestInputTokens:o.u[0]});
 const states=raw.observations.filter(t=>t.kind==='legacy'&&JSON.stringify(t.u)===JSON.stringify(o.u)).map(t=>({threadKey:t.key,turnKey:t.turn,at:t.at,signature:t.signature,total:t.total}));
 const receipts=raw.observations.filter(t=>t.kind==='response'&&JSON.stringify(t.u)===JSON.stringify(o.u)).map(t=>({threadKey:t.key,responseKey:t.response,turnKey:t.turn,at:t.at,threadTotal:t.threadTotal}));
 uncovered.push({threadKey:o.key,sessionKey:map[o.key]??o.key,responseKey:o.response,turnKey:o.turn,at:o.at,model:o.model,usage:o.u,usd:p.totalUsd,states,receipts});
}
const summary={uncoveredResponses:uncovered.length,input:uncovered.reduce((a,r)=>a+r.usage[0],0),output:uncovered.reduce((a,r)=>a+r.usage[2],0),usd:uncovered.reduce((a,r)=>a+r.usd,0)};
await writeFile('.lane/codex-collisions.json',JSON.stringify({summary,uncovered},null,2));console.log(JSON.stringify(summary));
