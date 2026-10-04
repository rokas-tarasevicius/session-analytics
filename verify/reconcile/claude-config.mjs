/** Supplemental config inventory: both default config locations; no account identifiers. */
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import { safeModel, safeTimestamp, safeFieldNames, costRecordFields, modelUsageFields, projectLastFields, failSafely } from './claude-privacy.mjs';
try {
const home=os.homedir(),h=x=>crypto.createHash('sha256').update(x).digest('hex').slice(0,12);
const roots=fs.readdirSync(home,{withFileTypes:true}).filter(e=>(e.isDirectory()||e.isSymbolicLink())&&/^\.claude(?:-|$)/.test(e.name)).map(e=>path.join(home,e.name));roots.push(path.join(home,'.config/claude'));if(process.env.CLAUDE_CONFIG_DIR)roots.push(process.env.CLAUDE_CONFIG_DIR);
const out=[];
for(const root of [...new Set(roots.flatMap(p=>{try{return [fs.realpathSync(p)];}catch{return [];}}))]){for(const [kind,file]of [...(root===path.join(home,'.claude')?[['home-default',path.join(home,'.claude.json')]]:[]),['profile-local',path.join(root,'.claude.json')]]){let c;try{c=JSON.parse(fs.readFileSync(file,'utf8'));}catch{out.push({profileKey:h(root),configKind:kind,available:false});continue;}const cache=c.cachedUsageUtilization,extra=cache?.utilization?.extra_usage,fields={};for(const key of ['utilization','monthly_limit','used_credits','is_enabled'])if(typeof extra?.[key]==='number'&&Number.isFinite(extra[key])||typeof extra?.[key]==='boolean')fields[key]=extra[key];out.push({profileKey:h(root),configKind:kind,available:true,projects:Object.keys(c.projects??{}).length,usageCacheObservedAt:safeTimestamp(cache?.fetchedAtMs),extraUsageProviderUnits:fields});}}
fs.writeFileSync('.lane/claude-config-audit.json',JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out));
} catch { failSafely(); }
