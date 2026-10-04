import './safe-failures.mjs';
import fs from 'node:fs';
import { matchesSchema, snapshotSchema } from '../../src/interop/schema.ts';
const snapshot=JSON.parse(fs.readFileSync(process.argv[2]||'../reference/snapshot-noindex-51ea561.json','utf8'));
const deref=sc=>sc.$ref?snapshotSchema.$defs[sc.$ref.slice('#/$defs/'.length)]:sc;
const matches=(value,schema)=>matchesSchema(value,{...schema,$defs:snapshotSchema.$defs});
const failures=[];
function diagnose(value,sc,path){
 sc=deref(sc);if(matches(value,sc))return;
 if(sc.anyOf){failures.push({path,reason:'anyOf',type:typeof value,numericValue:typeof value==='number'?value:undefined,alternatives:sc.anyOf.map(x=>x.type||('const'in x?'enum':'schema'))});return;}
 if(sc.type==='object'&&value&&typeof value==='object'&&!Array.isArray(value)){
  for(const k of sc.required||[])if(!Object.hasOwn(value,k))failures.push({path:path+'.'+k,reason:'missing'});
  for(const [k,v]of Object.entries(value)){const property=sc.properties?.[k];if(property)diagnose(v,property,path+'.'+k);else if(typeof sc.additionalProperties==='object')diagnose(v,sc.additionalProperties,path+'.<entry>');else failures.push({path,reason:'unexpected-key'});}
 }else if(sc.type==='array'&&Array.isArray(value)){
  if(value.length>(sc.maxItems??100000))failures.push({path,reason:'array-limit',length:value.length,limit:sc.maxItems??100000});
  for(let i=0;i<value.length;i++){const itemSchema=sc.prefixItems?.[i]||sc.items;if(itemSchema&&!matches(value[i],itemSchema))diagnose(value[i],itemSchema,path+'['+i+']');}
 }else failures.push({path,reason:'scalar-rule',type:typeof value,numericValue:typeof value==='number'?value:undefined,length:typeof value==='string'?value.length:undefined,rule:{type:sc.type,minimum:sc.minimum,maximum:sc.maximum,minLength:sc.minLength,maxLength:sc.maxLength,pattern:Boolean(sc.pattern)}});
}
const full=matchesSchema(snapshot,snapshotSchema);diagnose(snapshot,snapshotSchema,'snapshot');
const badSessionIndexes=new Set(failures.flatMap(f=>{const m=/sessions\[(\d+)\]/.exec(f.path);return m?[Number(m[1])]:[]}));
const byNamespace={};for(const i of badSessionIndexes)for(const link of snapshot.sessions[i].outcomes?.links||[]){const prefix=['workspace-pr','commit-event','pr-event','pr'].find(prefix=>link.ref.startsWith(prefix+'-'));if(prefix)byNamespace[prefix]=(byNamespace[prefix]||0)+1;}
const byMonth={};for(const i of badSessionIndexes){const session=snapshot.sessions[i],month=session.createdAt.slice(0,7);const r=byMonth[month]||{sessions:0,tokens:0,usd:0};r.sessions++;r.tokens+=session.tokens.inputTokens+session.tokens.outputTokens;r.usd+=session.cost.totalUsd;byMonth[month]=r;}
const result={matches:full,failures,affectedSessions:badSessionIndexes.size,byNamespace,byMonth};fs.writeFileSync('.lane/schema-rejection-results.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({matches:full,failures:failures.length,fields:[...new Set(failures.map(f=>f.path.replace(/\[\d+\]/g,'[]')))]},null,2));
