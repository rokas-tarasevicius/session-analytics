// Aggregate established corrections; this does not infer missing history or reprice it.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
const read = name => JSON.parse(readFileSync(name, 'utf8'));
const hash = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
try {
  const reference = read(join(homedir(), 'session-analytics-lanes/reference/snapshot-noindex-51ea561.json'));
  const native = read('.lane/codex-accounting.json');
  const fallback = read('.lane/codex-fallback-evidence.json');
  const conductor = read('.lane/conductor-patch-impact.json');
  const sessions = new Map(reference.sessions.map(s => [s.sessionKey, s]));
  const changes = [
    { bug: 'RC-CODEX-01', sessionKey: 'f2302365a96c', month: '2026-09', monthBasis: 'activity', usd: native.missing.usd, tokens: native.missing.input + native.missing.output },
    { bug: 'RC-CODEX-02', sessionKey: '1e2299f61050', month: '2026-04', monthBasis: 'activity', usd: -fallback.overcountUsd, tokens: -fallback.overcountTokens },
    ...conductor.changes.filter(c => c.removedUsd > 1e-8).map(c => ({ bug: 'RC-CONDUCTOR-REPLAY', sessionKey: c.sessionKey, month: c.month, monthBasis: 'session-start', usd: -c.removedUsd, tokens: c.addedTokens })),
  ].map(change => {
    const session = sessions.get(change.sessionKey);
    if (!session) throw new Error('Expected correction identity missing.');
    return { ...change, provider: session.provider, repositoryKey: hash(session.repositoryId), referenceUsd: session.cost.totalUsd };
  });
  const sum = rows => ({ sessions: new Set(rows.map(r => r.sessionKey)).size, usd: rows.reduce((n, r) => n + r.usd, 0), tokens: rows.reduce((n, r) => n + r.tokens, 0) });
  const group = key => Object.entries(Object.groupBy(changes, r => r[key])).map(([value, rows]) => ({ [key]: value, ...sum(rows) }));
  const report = { cutoff: reference.generatedAt, scope: 'Demonstrated corrections only; excluded optional LOCAL/MODEL proposals, suspected broader carryover, and history-recovery orphan.', summary: sum(changes), byBug: group('bug'), byProvider: group('provider'), byRepository: group('repositoryKey'), changes };
  writeFileSync('.lane/reconciliation-impact.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ summary: report.summary, repositories: report.byRepository.length, byBug: report.byBug }));
} catch { console.error('Impact aggregation failed; raw error suppressed.'); process.exitCode = 1; }
