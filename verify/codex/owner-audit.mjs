/** Post-oracle review of ownership heuristics, over sanitized observations only. */
import fs from 'node:fs';
import {priceUsage} from './pricing-oracle.mjs';
const d=JSON.parse(fs.readFileSync('.lane/codex-observations.json','utf8'));
const files=new Map(d.sessions.map(s=>[s.file,{...s,key:s.metas[0]?.id??s.key,metaAt:s.metas[0]?.at??s.metaAt}]));
const byKey=new Map([...files.values()].map(s=>[s.key,s]));
const groups=new Map();for(const raw of d.observations){if(raw.kind!=='legacy')continue;const o={...raw,key:files.get(raw.file).key};if(!groups.has(o.signature))groups.set(o.signature,[]);groups.get(o.signature).push(o)}
const ancestors=s=>{let p=s.fork??s.parent;const seen=new Set();while(p&&!seen.has(p)){seen.add(p);const a=byKey.get(p);p=a?.fork??a?.parent}return seen};
const age=(o,k)=>{let a=Date.parse(o[k]),t=Date.parse(o.at);return Number.isFinite(a)&&a<=t?t-a:Infinity};
const score=(o,mode)=>mode==='source'?age(o,'activityAt'):Math.min(age(o,'responseAt'),o.activityType==='token_usage_record'?age(o,'activityAt'):Infinity);
const better=(a,b,mode)=>score(a,mode)<score(b,mode)||(score(a,mode)===score(b,mode)&&a.at<b.at);
const choose=(g,mode)=>g.reduce((a,b)=>better(b,a,mode)?b:a);
const replay=(o,g)=>{const f=files.get(o.file),set=ancestors(f),birth=Date.parse(f.metaAt);return Number.isFinite(birth)&&g.some(p=>set.has(p.key)&&Date.parse(p.at)<birth)};
const model=o=>o.model??(files.get(o.file).modelList.length===1?files.get(o.file).modelList[0]:'<unknown>');
const price=o=>priceUsage(model(o),{input_tokens:o.u[0],cached_input_tokens:o.u[1],output_tokens:o.u[2],reasoning_output_tokens:o.u[3]},{timestamp:o.at,requestInputTokens:o.u[0]}).totalUsd;
const nonResponse=new Set(['user_message','task_started','task_complete','turn_aborted','world_state','thread_goal_updated','session_meta','turn_context']);
const totals={positiveStates:0,stablePositiveSourceStates:0,sourceWinnersByActivityType:{},nonReplayWinnersByActivityType:{},changedAfterReplayRemoval:0,clearlyNonResponseChanged:0,modelChanged:0,fromUsd:0,toUsd:0,input:0,output:0,patch02DroppedAncestralProof:0,patch02MissedPositiveReplayOwners:0};const changed=[],missed=[];
const add=(map,o)=>{const k=o.activityType??'unknown';map[k]??={states:0,input:0,output:0,usd:0};map[k].states++;map[k].input+=o.u[0];map[k].output+=o.u[2];map[k].usd+=price(o)};
for(const[signature,g]of groups){if(!g[0].u[0]&&!g[0].u[2])continue;totals.positiveStates++;const source=choose(g,'source');if(files.get(source.file).live)continue;totals.stablePositiveSourceStates++;add(totals.sourceWinnersByActivityType,source);
 const perFile=new Map();for(const o of g){const old=perFile.get(o.file);if(!old||better(o,old,'source'))perFile.set(o.file,o)}const collapsed=[...perFile.values()];
 const eligible=g.filter(o=>!replay(o,g));const patchEligible=collapsed.filter(o=>!replay(o,collapsed));
 if(collapsed.some(o=>replay(o,g)&&!replay(o,collapsed)))totals.patch02DroppedAncestralProof++;
 if(patchEligible.length){const p=choose(patchEligible,'source');if(replay(p,g)){totals.patch02MissedPositiveReplayOwners++;missed.push({signature,owner:p.key,at:p.at,usage:p.u})}}
 if(!eligible.length)continue;const old=choose(eligible,'source'),next=choose(eligible,'generated');if(files.get(old.file).live||files.get(next.file).live)continue;add(totals.nonReplayWinnersByActivityType,old);if(old.key===next.key)continue;
 totals.changedAfterReplayRemoval++;if(nonResponse.has(old.activityType))totals.clearlyNonResponseChanged++;if(model(old)!==model(next))totals.modelChanged++;totals.fromUsd+=price(old);totals.toUsd+=price(next);totals.input+=old.u[0];totals.output+=old.u[2];changed.push({signature,oldKey:old.key,newKey:next.key,oldActivityType:old.activityType,oldSourceGap:score(old,'source'),oldResponseGap:Number.isFinite(score(old,'generated'))?score(old,'generated'):null,newResponseGap:Number.isFinite(score(next,'generated'))?score(next,'generated'):null,oldModel:model(old),newModel:model(next),fromUsd:price(old),toUsd:price(next),usage:old.u});
}
const report={totals,changed,missed};fs.writeFileSync('.lane/codex-owner-audit.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(totals,null,2));
