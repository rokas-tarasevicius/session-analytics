// Summarize only the sanitized oracle projection; no access to private history.
import { readFileSync, writeFileSync } from 'node:fs';
const data=JSON.parse(readFileSync('.lane/repos-oracle.json','utf8'));
const eligible=data.rows.filter((r:any)=>!r.active);
function classification(r:any):string|null {
 if(r.matches)return null;
 if(['metadata-remote','metadata-unregistered'].includes(r.route))return 'R-GIT-04';
 if(r.route==='git'&&r.physicalRegisteredRoots.length===0)return 'R-GIT-03';
 if(r.route==='no-repository'&&r.cwdIsSymlink)return 'R-GIT-01';
 if(r.provider==='cursor'&&r.route==='unresolved')return 'R-CURSOR-03';
 return 'UNADJUDICATED';
}
const rows=eligible.filter((r:any)=>!r.matches).map((r:any)=>({...r,bug:classification(r)}));
const sum=(rs:any[])=>({sessions:rs.length,costUsd:rs.reduce((n,r)=>n+r.costUsd,0),inputTokens:rs.reduce((n,r)=>n+r.inputTokens,0),outputTokens:rs.reduce((n,r)=>n+r.outputTokens,0),tokens:rs.reduce((n,r)=>n+r.tokens,0),months:[...new Set(rs.map(r=>r.month))].sort()});
const group=(rs:any[],field:string)=>Object.fromEntries([...new Set(rs.map(r=>r[field]))].sort().map(k=>[k,sum(rs.filter(r=>r[field]===k))]));
const byModel:Record<string,any>={};
for(const row of rows)for(const m of row.models){const v=byModel[m.model]??={sessions:new Set<string>(),costUsd:0,inputTokens:0,outputTokens:0};v.sessions.add(row.sessionKey);v.costUsd+=m.costUsd;v.inputTokens+=m.inputTokens;v.outputTokens+=m.outputTokens;}
for(const v of Object.values(byModel)){v.sessions=v.sessions.size;v.tokens=v.inputTokens+v.outputTokens;}
const expected=rows.map((r:any)=>({...r,target:r.expectedRepositoryIds[0]??(r.route==='unresolved'?'unassigned':`identity-${r.identityHash}`)}));
const result={referenceGeneratedAt:data.referenceGeneratedAt,coverage:data.coverage,eligible:sum(eligible),agreed:sum(eligible.filter((r:any)=>r.matches)),impact:sum(rows),excluded:sum(data.rows.filter((r:any)=>r.active)),byBug:group(rows,'bug'),byMonth:group(rows,'month'),byProvider:group(rows,'provider'),byModel,byActualRepository:group(rows,'actualRepositoryId'),byExpectedRepository:group(expected,'target'),byBucket:group(eligible,'bucket'),splits:data.splits,rows};
writeFileSync('.lane/impact.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({coverage:result.coverage,impact:result.impact,byBug:result.byBug,byMonth:result.byMonth,byProvider:result.byProvider,byModel:result.byModel},null,2));
