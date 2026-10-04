/** Post-oracle lineage audit over sanitized raw projections; no provider source imports. */
import fs from 'node:fs';
import {priceUsage} from './pricing-oracle.mjs';
const d=JSON.parse(fs.readFileSync('.lane/codex-observations.json','utf8'));
const files=new Map(d.sessions.map(s=>[s.file,{...s,key:s.metas[0]?.id??s.key,metaAt:s.metas[0]?.at??s.metaAt,source:s.metas[0]?.source??s.source}]));
const byKey=new Map([...files.values()].map(s=>[s.key,s]));
const groups=new Map();
for(const o0 of d.observations){if(o0.kind!=='legacy')continue;const f=files.get(o0.file),o={...o0,key:f.key};if(!groups.has(o.signature))groups.set(o.signature,[]);groups.get(o.signature).push(o)}
const ancestors=s=>{const seen=new Set();let parent=s.fork??s.parent;while(parent&&!seen.has(parent)){seen.add(parent);const p=byKey.get(parent);parent=p?.fork??p?.parent}return seen};
const score=o=>{let a=Date.parse(o.activityAt),t=Date.parse(o.at);return Number.isFinite(a)&&a<=t?t-a:Infinity};
const better=(a,b)=>score(a)<score(b)||(score(a)===score(b)&&a.at<b.at);
const model=o=>o.model??(files.get(o.file).modelList.length===1?files.get(o.file).modelList[0]:'<unknown>');
const price=o=>priceUsage(model(o),{input_tokens:o.u[0],cached_input_tokens:o.u[1],output_tokens:o.u[2],reasoning_output_tokens:o.u[3]},{timestamp:o.at,requestInputTokens:o.u[0]}).totalUsd;
const stats={states:groups.size,statesWithAncestralReplay:0,replayedObservations:0,sourceSelectedReplay:0,stableSourceSelectedReplay:0,input:0,output:0,fromUsd:0,toUsd:0,modelsChanged:0,monthsChanged:0};const rows=[];
for(const [signature,g]of groups){let replay=[];for(const o of g){const f=files.get(o.file);if(!f.fork&&!f.parent)continue;const parents=ancestors(f),before=Date.parse(f.metaAt);const prior=g.filter(p=>parents.has(p.key)&&Date.parse(p.at)<before);if(prior.length)replay.push({o,ancestor:prior.reduce((a,b)=>Date.parse(a.at)<Date.parse(b.at)?a:b)})}
 if(!replay.length)continue;stats.statesWithAncestralReplay++;stats.replayedObservations+=replay.length;
 const owner=g.filter(o=>o.at).reduce((a,b)=>better(b,a)?b:a);const selected=replay.find(r=>r.o===owner);if(!selected)continue;stats.sourceSelectedReplay++;
 const parent=selected.ancestor;if(files.get(owner.file).live||files.get(parent.file).live)continue;stats.stableSourceSelectedReplay++;stats.input+=owner.u[0];stats.output+=owner.u[2];stats.fromUsd+=price(owner);stats.toUsd+=price(parent);if(model(owner)!==model(parent))stats.modelsChanged++;if(owner.at.slice(0,7)!==parent.at.slice(0,7))stats.monthsChanged++;
 rows.push({signature,fromKey:owner.key,toKey:parent.key,fromModel:model(owner),toModel:model(parent),fromMonth:owner.at.slice(0,7),toMonth:parent.at.slice(0,7),usage:owner.u,fromUsd:price(owner),toUsd:price(parent),fromResponseGap:owner.responseGap,fromActivityType:owner.activityType,fromScore:score(owner),toScore:score(parent)});
}
fs.writeFileSync('.lane/codex-fork-replay-audit.json',JSON.stringify({stats,rows},null,2)+'\n');console.log(JSON.stringify(stats,null,2));
