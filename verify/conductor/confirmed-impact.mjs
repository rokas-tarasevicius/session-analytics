// Attribute certified duplicated contributions without running application code.
import fs from 'node:fs';
for(const event of ['uncaughtException','unhandledRejection'])process.on(event,()=>{console.error('Impact projection failed; raw error suppressed.');process.exit(1);});
const read=name=>JSON.parse(fs.readFileSync(`.lane/${name}.json`,'utf8'));
const sem=read('conductor-semantics'), reference=read('conductor-reference'), accounting=read('conductor-accounting');
const cert=read('conductor-overlap-certificates'), suffix=read('conductor-model-suffix-impact');
const refs=new Map(reference.sessions.map(s=>[s.sessionKey,s]));
const raw=new Map(sem.sessions.map(s=>[s.sessionKey,s]));
const totals={usd:0,tokens:0,pairs:0};const byModel={},byRepository={},byMonth={},bySession={};
function add(target,key,usd,tokens){const v=target[key]??={usd:0,tokens:0,pairs:0};v.usd+=usd;v.tokens+=tokens;v.pairs++;}
for(const c of cert.certificates){
  const p=raw.get(c.sessionKey).results[c.previousSequence];
  totals.usd+=c.duplicatedPreviousCostUsd;totals.tokens+=c.duplicatedPreviousTokens;totals.pairs++;
  add(bySession,c.referenceSessionKey,c.duplicatedPreviousCostUsd,c.duplicatedPreviousTokens);
  add(byMonth,c.month,c.duplicatedPreviousCostUsd,c.duplicatedPreviousTokens);
  add(byRepository,refs.get(c.referenceSessionKey).repositoryKey,c.duplicatedPreviousCostUsd,c.duplicatedPreviousTokens);
  for(const [model,m] of Object.entries(p.modelUsage))add(byModel,model,m.costUSD??0,(m.inputTokens??0)+(m.cacheReadInputTokens??0)+(m.cacheCreationInputTokens??0)+(m.outputTokens??0));
}
const unknown=new Set(suffix.sessions.map(s=>s.sessionKey));
const discrepancies=accounting.sessions.map(a=>{
  const r=refs.get(a.referenceSessionKey),s=raw.get(a.sessionKey),proof=bySession[a.referenceSessionKey];
  const five=s.results.reduce((n,r)=>n+(r.usage.cache_creation?.ephemeral_5m_input_tokens??0),0);
  const hour=s.results.reduce((n,r)=>n+(r.usage.cache_creation?.ephemeral_1h_input_tokens??0),0);
  const falseModelWarning=r.models.length>0&&r.models.every(m=>!m.priced)&&r.cost.totalUsd>1e-6;
  const bugs=['VC-O2'];if(proof)bugs.push('VC-001');if(unknown.has(r.sessionKey))bugs.push('VC-P1');if(five+hour>0)bugs.push('VC-P3');if(falseModelWarning)bugs.push('VC-P4');
  return {sessionKey:r.sessionKey,repositoryKey:r.repositoryKey,month:a.month,confirmedBugs:bugs,
    referenceUsd:a.referenceUsd,referenceTokens:a.referenceInputTokens+a.referenceOutputTokens,
    certifiedDuplicatedUsd:proof?.usd??0,certifiedDuplicatedTokens:proof?.tokens??0,
    scopeClassification:a.classification,receiptFloorUsd:a.maxTotalUsd,
    marginalLedgerDisagreementUsd:a.classification==='explicit-marginal-complete'?a.marginalUsd-a.referenceUsd:null,
    marginalLedgerIsVerifiedCorrection:false,ttlClassificationLost:{fiveMinute:five,oneHour:hour},
    explanationTags:a.residualExplanationTags};
});
fs.writeFileSync('.lane/conductor-confirmed-impact.json',JSON.stringify({provider:'claude',totals,byMonth,byModel,byRepository,bySession},null,2));
fs.writeFileSync('.lane/conductor-discrepancies.json',JSON.stringify({cutoff:reference.generatedAt,sessions:discrepancies},null,2));
console.log(JSON.stringify({totals,sessions:discrepancies.length,certifiedSessions:Object.keys(bySession).length,models:Object.keys(byModel).length,repositories:Object.keys(byRepository).length}));
