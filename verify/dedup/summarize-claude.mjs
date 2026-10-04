import fs from 'node:fs';
const x=JSON.parse(fs.readFileSync('.lane/claude-oracle.json','utf8'));
const stable=x.sessions.filter(s=>!s.liveAfterCutoff&&s.referencePresent);
const rollups={provider:'claude',stableSessions:stable.length,liveExcluded:x.sessionCounts.liveExcluded,totalPhysicalTokens:0,totalDollars:0,totalPhysicalTokenDelta:0,totalDollarDelta:0,models:{},repositories:{},monthly:{}};
for(const s of stable) {
  rollups.totalPhysicalTokens+=s.tokens.inputTokens+s.tokens.outputTokens;
  rollups.totalDollars+=s.dollars;
  rollups.totalPhysicalTokenDelta+=s.delta.tokens.inputTokens+s.delta.tokens.outputTokens;
  rollups.totalDollarDelta+=s.delta.dollars;
  const r=rollups.repositories[s.reference.repositoryKey]||={sessions:0,tokens:0,dollars:0,tokenDelta:0,dollarDelta:0};
  r.sessions++;r.tokens+=s.tokens.inputTokens+s.tokens.outputTokens;r.dollars+=s.dollars;
  r.tokenDelta+=s.delta.tokens.inputTokens+s.delta.tokens.outputTokens;r.dollarDelta+=s.delta.dollars;
  for(const [model,m]of Object.entries(s.byModel)) {
    const v=rollups.models[model]||={messages:0,inputTokens:0,outputTokens:0,dollars:0};
    v.messages+=m.messages;v.inputTokens+=m.tokens.inputTokens;v.outputTokens+=m.tokens.outputTokens;v.dollars+=m.dollars;
  }
  for(const [month,m]of Object.entries(s.byMonth)) {
    const v=rollups.monthly[month]||={sessions:0,tokens:0,dollars:0,referenceDollars:0};
    v.sessions++;v.tokens+=m.tokens.inputTokens+m.tokens.outputTokens;v.dollars+=m.dollars;
  }
  for(const [day,value]of Object.entries(s.reference.spendByDay)) {
    const month=day.slice(0,7),v=rollups.monthly[month]||={sessions:0,tokens:0,dollars:0,referenceDollars:0};
    v.referenceDollars+=value;
  }
}
const summary={stats:x.stats,counts:x.sessionCounts,legacyAliases:x.legacyAliases,tokenMismatches:stable.filter(s=>Object.values(s.delta.tokens).some(Boolean)).map(s=>({sessionKey:s.sessionKey,tokens:s.delta.tokens,dollars:s.delta.dollars})),files:stable.reduce((n,s)=>n+s.files,0),nativeDuplicateFiles:stable.filter(s=>s.mainFiles>1).length,duplicateMessagesWithinComposites:stable.reduce((n,s)=>n+s.fileSums.reduce((v,f)=>v+f.uniqueMessages,0)-Object.values(s.byModel).reduce((v,m)=>v+m.messages,0),0),ttlReconciliations:x.ttlReconciliations};
fs.writeFileSync('.lane/claude-summary.json',JSON.stringify(summary,null,2)+'\n');
fs.writeFileSync('.lane/claude-rollups.json',JSON.stringify(rollups,null,2)+'\n');
console.log(JSON.stringify({stableSessions:rollups.stableSessions,physicalTokenDelta:rollups.totalPhysicalTokenDelta,dollarDelta:rollups.totalDollarDelta,monthly:rollups.monthly},null,2));
