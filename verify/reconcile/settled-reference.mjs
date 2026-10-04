// Apply independently observed liveness exclusions to the frozen reference.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { reconcileReference } from './reference.mjs';
try {
  const read = async path => JSON.parse(await readFile(path,'utf8'));
  const snapshot = await read(join(homedir(),'session-analytics-lanes/reference/snapshot-noindex-51ea561.json'));
  const claude = await read('.lane/claude-aggregates.json');
  const codex = await read('.lane/codex-raw-oracle.json');
  const conductor = await read('.lane/conductor-evidence.json');
  const excluded = new Set();
  for (const s of claude.sessions) if(s.liveAfterCutoff) {
    if(s.referenceSessionKey) excluded.add(s.referenceSessionKey);
    if(s.sessionKey) excluded.add(s.sessionKey);
  }
  for (const s of [...codex.fileRows,...codex.dbRows]) if(s.afterCutoff) {
    if(s.sessionKey) excluded.add(s.sessionKey);
    if(s.providerKey) excluded.add(s.providerKey);
  }
  for (const s of conductor.sessions) if(s.lastMessageAt>snapshot.generatedAt) {
    if(s.sessionKey) excluded.add(s.sessionKey);
    if(s.providerKey) excluded.add(s.providerKey);
  }
  const result = reconcileReference(snapshot,excluded);
  result.excludedSessionKeys = snapshot.sessions.filter(s=>excluded.has(s.sessionKey)).map(s=>s.sessionKey);
  await writeFile('.lane/reference-settled-aggregates.json',JSON.stringify(result,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({excludedSessions:result.excludedSessions,totals:result.totals}));
} catch { console.error('Settled reference comparison failed; raw error suppressed.');process.exitCode=1; }
