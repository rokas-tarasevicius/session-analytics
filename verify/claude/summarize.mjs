// Reconcile privacy-safe oracle artifacts against the fixed reference. No src imports.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
process.setUncaughtExceptionCaptureCallback(() => { console.error('Claude summary reconciliation failed; inspect aggregate evidence.'); process.exit(1); });
const read = name => JSON.parse(fs.readFileSync(name, 'utf8'));
const oracle=read('.lane/claude-oracle.json');
const reference=read(path.join(os.homedir(),'session-analytics-lanes/reference/snapshot-noindex-51ea561.json'));
const refs=new Map(reference.sessions.filter(s=>s.provider==='claude').map(s=>[s.sessionKey,s]));
const tokenFields=Object.keys(oracle.sessions[0].tokens);
const total=()=>({sessions:0,costUSD:0,tokens:Object.fromEntries(tokenFields.map(k=>[k,0]))});
const sum=(target,s,cost)=>{target.sessions++;target.costUSD+=cost;for(const k of tokenFields)target.tokens[k]+=s.tokens[k];};
const observed=total(),expected=total(),live=total(),recovery=total();
let datedCells=0,multiday=0,multimonth=0;
const executionChanges=[],unexplained=[];
for(const s of oracle.sessions){
  const r=refs.get(s.sessionKey);assert.ok(r);sum(observed,r,r.cost.totalUsd);sum(expected,s,s.costUSD);
  assert.equal(s.files,r.transcript.files);assert.equal(s.firstEventAt,r.firstEventAt);assert.equal(s.lastEventAt,r.lastEventAt);
  datedCells+=Object.keys(s.spendByDay).length;
  multiday+=Number(Object.keys(s.spendByDay).length>1);
  multimonth+=Number(new Set(Object.keys(s.spendByDay).map(d=>d.slice(0,7))).size>1);
  for(const k of ['topLevelUsd','subagentUsd'])if(Math.abs(s.costByExecution[k]-r.costByExecution[k])>1e-8)executionChanges.push({sessionKey:s.sessionKey,execution:k,deltaUSD:s.costByExecution[k]-r.costByExecution[k]});
}
for(const s of oracle.ignored){const r=refs.get(s.sessionKey);if(r)sum(live,r,r.cost.totalUsd);}
for(const s of oracle.referenceOnly){const r=refs.get(s.sessionKey);assert.equal(r.evidence.source,'conductor-result');sum(recovery,r,r.cost.totalUsd);}
assert.equal(observed.sessions+live.sessions+recovery.sessions,refs.size);
const money=oracle.diffs.filter(d=>Math.abs(d.deltaCostUSD)>1e-8);
for(const d of oracle.diffs){
  if(d.deltaCompactions!==0)unexplained.push({sessionKey:d.sessionKey,field:'compactions'});
  if(d.deltaTokens.reasoningOutputTokens!==0||d.deltaTokens.cacheWriteInputTokens!==0||d.deltaTokens.cacheWrite1hInputTokens!==0||d.deltaTokens.cacheWrite5mInputTokens!==0)unexplained.push({sessionKey:d.sessionKey,field:'unexpected-token-class'});
  if(Math.abs(d.deltaCostUSD)<1e-8&&(d.deltaTokens.inputTokens!==0||d.deltaTokens.outputTokens!==0||d.deltaCalls!==0||Object.keys(d.dayDelta).length))unexplained.push({sessionKey:d.sessionKey,field:'non-iteration-accounting'});
}
const iterationEvidence=read('.lane/claude-iterations-impact.json');
assert.ok(Math.abs(expected.costUSD-observed.costUSD-iterationEvidence.total)<1e-8);
assert.equal(expected.tokens.inputTokens-observed.tokens.inputTokens,984681);
assert.equal(expected.tokens.outputTokens-observed.tokens.outputTokens,8479);
assert.deepEqual(unexplained,[]);
const summary={referenceGeneratedAt:reference.generatedAt,observed,expected,live,recovery,correctionUSD:expected.costUSD-observed.costUSD,addedInputTokens:expected.tokens.inputTokens-observed.tokens.inputTokens,addedOutputTokens:expected.tokens.outputTokens-observed.tokens.outputTokens,unknownOutputMisclassified:observed.tokens.nonReasoningOutputTokens-expected.tokens.nonReasoningOutputTokens,classificationAffectedSessions:oracle.diffs.filter(d=>d.deltaTokens.nonReasoningOutputTokens>0).length,costAffectedSessions:money.length,differencesOver50CentsOr1Percent:money.filter(d=>Math.abs(d.deltaCostUSD)>.5||Math.abs(d.deltaCostUSD)>d.referenceCostUSD*.01).length,datedCells,multiday,multimonth,models:Object.keys(oracle.models).length,repositories:Object.keys(oracle.repositories).length,compactions:oracle.sessions.reduce((n,s)=>n+s.compactions,0),executionChanges,unexplained};
fs.writeFileSync('.lane/claude-validation-summary.json',JSON.stringify(summary,null,2)+'\n');
const rows=['| Session key | Oracle minus reference USD | Input added | Output added | Output wrongly labeled non-reasoning |','|---|---:|---:|---:|---:|',...oracle.diffs.map(d=>`| ${d.sessionKey} | ${(-d.deltaCostUSD).toFixed(8)} | ${-d.deltaTokens.inputTokens} | ${-d.deltaTokens.outputTokens} | ${d.deltaTokens.nonReasoningOutputTokens} |`)];
fs.writeFileSync('.lane/claude-diff-table.md',rows.join('\n')+'\n');
console.log(JSON.stringify(summary));
