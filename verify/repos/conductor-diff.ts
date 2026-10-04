/** Direct DB ownership comparison; no analyzer imports and no private output. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hashId, loadConductor } from './conductor-oracle.ts';

interface SnapshotSession {
  sessionKey: string;
  repositoryId: string;
  provider: string;
  firstEventAt?: string | null;
  lastEventAt?: string | null;
  cost: { totalUsd: number };
  tokens: { inputTokens: number; outputTokens: number };
}
interface Totals { sessions: number; costUsd: number; inputTokens: number; outputTokens: number }
const totals = (): Totals => ({ sessions: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 });
function add(total: Totals, row: SnapshotSession): void {
  total.sessions++;
  total.costUsd += row.cost.totalUsd;
  total.inputTokens += row.tokens.inputTokens;
  total.outputTokens += row.tokens.outputTokens;
}

try {
  const home = homedir();
  const referencePath = process.argv[2] ?? join(home, 'session-analytics-lanes/reference/snapshot-noindex-51ea561.json');
  const output = process.argv[3] ?? '.lane/conductor-reference-diff.json';
  const snapshot = JSON.parse(readFileSync(referencePath, 'utf8')) as { generatedAt: string; sessions: SnapshotSession[] };
  const data = loadConductor(home);
  const byKey = new Map(snapshot.sessions.map(row => [row.sessionKey, row]));
  const cutoff = Date.parse(snapshot.generatedAt);
  const matched = totals();
  const mismatched = totals();
  const byProvider: Record<string, Totals> = {};
  const byMonth: Record<string, Totals> = {};
  const missing: Array<Record<string, unknown>> = [];
  const diff: Array<Record<string, unknown>> = [];
  let excludedLive = 0;
  let missingWorkspace = 0;
  for (const session of data.sessions) {
    if (Date.parse(session.updated_at) > cutoff || Date.parse(session.created_at) > cutoff) { excludedLive++; continue; }
    const key = hashId(session.id);
    const row = byKey.get(key);
    const workspace = session.workspace_id ? data.workspacesById.get(session.workspace_id) : undefined;
    const provider = ['claude', 'codex', 'cursor'].includes(session.agent_type) ? session.agent_type : 'other';
    if (!row) {
      missing.push({ sessionKey: key, hasProviderId: !!session.claude_session_id, hasWorkspace: !!workspace, provider });
      continue;
    }
    if (!workspace) { missingWorkspace++; continue; }
    const expected = `conductor-${createHash('sha256').update(`conductor:${workspace.repository_id}`).digest('hex').slice(0, 20)}`;
    if (row.repositoryId === expected) {
      add(matched, row);
      add(byProvider[provider] ??= totals(), row);
      const month = /^\d{4}-\d{2}/.exec(row.firstEventAt ?? '')?.[0] ?? 'unknown';
      add(byMonth[month] ??= totals(), row);
    } else {
      add(mismatched, row);
      diff.push({ sessionKey: key, expectedRepoKey: hashId(expected), actualRepoKey: hashId(row.repositoryId), provider, costUsd: row.cost.totalUsd, inputTokens: row.tokens.inputTokens, outputTokens: row.tokens.outputTokens });
    }
  }
  const evidence = { generatedAt: snapshot.generatedAt, dbSessions: data.sessions.length, excludedLive, matched, mismatched, missingWorkspace, missingCount: missing.length, byProvider, byMonth, diff, missing };
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ ...evidence, diff: undefined, missing: undefined }, null, 2));
} catch { console.error('Conductor comparison failed; no local error text emitted.'); process.exitCode = 1; }
