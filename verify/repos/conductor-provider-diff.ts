/** Check result-fallback repository ownership through DB provider identity only. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hashId, loadConductor } from './conductor-oracle.ts';

interface SnapshotRow {
  sessionKey: string;
  repositoryId: string;
  provider: string;
  createdAt: string;
  firstEventAt?: string | null;
  evidence?: { source?: string };
  cost: { totalUsd: number };
  tokens: { inputTokens: number; outputTokens: number };
}
interface Totals { sessions: number; costUsd: number; inputTokens: number; outputTokens: number; tokens: number }
const empty = (): Totals => ({ sessions: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, tokens: 0 });
function add(total: Totals, row: SnapshotRow): void {
  total.sessions++;
  total.costUsd += row.cost.totalUsd;
  total.inputTokens += row.tokens.inputTokens;
  total.outputTokens += row.tokens.outputTokens;
  total.tokens += row.tokens.inputTokens + row.tokens.outputTokens;
}

try {
  const home = homedir();
  const file = process.argv[2] ?? join(home, 'session-analytics-lanes/reference/snapshot-noindex-51ea561.json');
  const output = process.argv[3] ?? '.lane/conductor-provider-identity-diff.json';
  const snapshot = JSON.parse(readFileSync(file, 'utf8')) as { generatedAt: string; sessions: SnapshotRow[] };
  const db = loadConductor(home);
  const keys = new Map(db.sessions.filter(session => !!session.claude_session_id).map(session => [hashId(`${session.agent_type}:${session.claude_session_id}`), session]));
  const rows: Array<Record<string, unknown>> = [];
  const byMonth: Record<string, Totals> = {};
  const summary = { ...empty(), matched: 0, missingDbIdentity: 0, missingWorkspace: 0, excludedLive: 0 };
  for (const row of snapshot.sessions.filter(session => session.evidence?.source === 'conductor-result')) {
    const session = keys.get(row.sessionKey);
    if (session && (Date.parse(session.updated_at) > Date.parse(snapshot.generatedAt) || Date.parse(session.created_at) > Date.parse(snapshot.generatedAt))) { summary.excludedLive++; continue; }
    const workspace = session?.workspace_id ? db.workspacesById.get(session.workspace_id) : undefined;
    const expected = workspace ? `conductor-${createHash('sha256').update(`conductor:${workspace.repository_id}`).digest('hex').slice(0, 20)}` : null;
    const matches = row.repositoryId === expected;
    const month = /^\d{4}-\d{2}/.exec(row.firstEventAt ?? row.createdAt)?.[0] ?? 'unknown';
    add(summary, row);
    add(byMonth[month] ??= empty(), row);
    summary.matched += Number(matches);
    summary.missingDbIdentity += Number(!session);
    summary.missingWorkspace += Number(!!session && !workspace);
    rows.push({ sessionKey: row.sessionKey, expectedRepoKey: expected ? hashId(expected) : null, actualRepoKey: hashId(row.repositoryId), source: 'conductor-result', provider: row.provider === 'claude' ? 'claude' : 'other', month, matches, costUsd: row.cost.totalUsd, inputTokens: row.tokens.inputTokens, outputTokens: row.tokens.outputTokens });
  }
  writeFileSync(output, `${JSON.stringify({ referenceGeneratedAt: snapshot.generatedAt, basis: 'Raw DB provider identities and workspace foreign keys establish ownership; reference cost and token values quantify assigned value only. Result-receipt accounting is not revalidated.', summary, byMonth, rows }, null, 2)}\n`);
  console.log(JSON.stringify({ summary, byMonth }, null, 2));
} catch { console.error('Conductor provider identity comparison failed; no local error text emitted.'); process.exitCode = 1; }
