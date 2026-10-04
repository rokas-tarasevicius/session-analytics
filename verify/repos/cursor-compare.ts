/** Independent Cursor-only reference diff. Public output is hashed or numeric. */
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { createHash } from 'node:crypto';
import { loadCursor } from './cursor-oracle.ts'; import { loadConductor } from './conductor-oracle.ts'; import { resolveRepository, canonicalizeRemote } from './git-oracle.ts';
const hash = (s: string, n = 12) => createHash('sha256').update(s).digest('hex').slice(0,n);
const home = os.homedir(); const records = loadCursor(home); const conductor = loadConductor(home);
const snapshot = JSON.parse(fs.readFileSync(path.join(home,'session-analytics-lanes/reference/snapshot-noindex-51ea561.json'),'utf8'));
const sessions = snapshot.sessions.filter((s: any) => s.provider === 'cursor');
const bySession = new Map(sessions.map((s: any) => [s.sessionKey,s]));
const identities = new Map<string,string[]>();
for (const r of conductor.repos) { const g = resolveRepository(r.root_path, r.remote_url); const remote = canonicalizeRemote(r.remote_url) || g.remote; const id = remote ? `remote:${remote}` : g.identity; identities.set(id, [...(identities.get(id)||[]), 'conductor-' + hash('conductor:'+r.id,20)]); }
const rows: any[] = [];
for (const r of records) {
 const db = conductor.sessions.filter(d => d.agent_type === 'cursor' && d.claude_session_id === r.id);
 const candidates = [hash('cursor:'+r.id),...db.map(d => hash(d.id))];
 const s: any = candidates.map(k => bySession.get(k)).find(Boolean);
 if (!s) { rows.push({ key: hash('cursor:'+r.id), source:r.source, inSnapshot:false, draft:!!r.isDraft, firstAt:r.firstAt,lastAt:r.lastAt }); continue; }
 const g = resolveRepository(r.cwd); let expected = identities.get(g.identity) || [];
 if (!expected.length && g.root) expected = ['discovered-' + hash(g.remote ? `remote:${g.remote}` : g.commonDir?.endsWith('/.git') ? path.dirname(g.commonDir) : g.root,20)];
 if (!expected.length) expected = db.flatMap(d=> { const w = conductor.workspacesById.get(d.workspace_id||''); return w ? ['conductor-'+hash('conductor:'+w.repository_id,20)] : []; });
 if (!expected.length && r.cwd) expected = conductor.workspaces.filter(w => w.candidatePaths.some(p => r.cwd === p || r.cwd!.startsWith(p + '/'))).map(w => 'conductor-'+hash('conductor:'+w.repository_id,20));
 if (!expected.length && r.cwd) expected = ['discovered-'+hash(r.cwd,20)];
 rows.push({key:s.sessionKey,source:r.source,inSnapshot:true,actual:s.repositoryId,expected,matches:expected.includes(s.repositoryId),active:!!r.lastAt&&r.lastAt>snapshot.generatedAt,costUsd:s.cost.totalUsd,inputTokens:s.tokens.inputTokens,outputTokens:s.tokens.outputTokens,route:g.confidence,evidence:g.evidence,month:(s.firstEventAt||s.createdAt||'unknown').slice(0,7)});
}
const eligible = rows.filter(r=>r.inSnapshot&&!r.active); const mismatch = eligible.filter(r=>!r.matches);
const total = (rs:any[])=>({sessions:rs.length,costUsd:rs.reduce((a,r)=>a+r.costUsd,0),inputTokens:rs.reduce((a,r)=>a+r.inputTokens,0),outputTokens:rs.reduce((a,r)=>a+r.outputTokens,0)});
const result={referenceCursorSessions:sessions.length,rawCursorSessions:records.length,matched:eligible.length,unmatched:rows.filter(r=>!r.inSnapshot).length,activeExcluded:rows.filter(r=>r.active).length,eligible:total(eligible),mismatch:total(mismatch),rows};
fs.writeFileSync('.lane/cursor-diff.json',JSON.stringify(result,null,2)+'\n'); console.log(JSON.stringify({referenceCursorSessions:result.referenceCursorSessions,rawCursorSessions:result.rawCursorSessions,matched:result.matched,unmatched:result.unmatched,activeExcluded:result.activeExcluded,eligible:result.eligible,mismatch:result.mismatch}));
