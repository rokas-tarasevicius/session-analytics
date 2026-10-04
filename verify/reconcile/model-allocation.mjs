// Allocation residuals are already retained in session totals: no new usage.
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
try {
  const reference = JSON.parse(readFileSync(join(homedir(), 'session-analytics-lanes/reference/snapshot-noindex-51ea561.json'), 'utf8'));
  const sessions = reference.sessions.map(s => ({
    sessionKey: s.sessionKey, provider: s.provider, basis: s.costBasis, models: s.models.length,
    month: s.createdAt?.slice(0, 7) ?? 'undated', value: s.cost.totalUsd,
    deltaUsd: s.cost.totalUsd - s.models.reduce((n, m) => n + m.totalUsd, 0),
    deltaInput: s.tokens.inputTokens - s.models.reduce((n, m) => n + m.inputTokens, 0),
    deltaOutput: s.tokens.outputTokens - s.models.reduce((n, m) => n + m.outputTokens, 0),
  })).filter(s => Math.abs(s.deltaUsd) > 1e-8 || s.deltaInput !== 0 || s.deltaOutput !== 0);
  const groups = {};
  for (const s of sessions) {
    const g = groups[`${s.provider}:${s.basis}`] ??= { sessions: 0, deltaUsd: 0, deltaInput: 0, deltaOutput: 0, months: {} };
    g.sessions++; g.deltaUsd += s.deltaUsd; g.deltaInput += s.deltaInput; g.deltaOutput += s.deltaOutput;
    g.months[s.month] = (g.months[s.month] ?? 0) + s.deltaUsd;
  }
  writeFileSync('.lane/model-rollup-gaps.json', JSON.stringify({ groups, sessions }, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(groups));
} catch { console.error('Model allocation comparison failed; raw error suppressed.'); process.exitCode = 1; }
