/** Independent absence checks: envelope times do not date aggregate token usage. */
type Row = Record<string, any>;
export function compareUnavailableCursorTime(session: Row, mode: 'run-summary' | 'activity-only', raw: Row = {}) {
  const fields: string[] = [];
  if (!session.spendByDay || typeof session.spendByDay !== 'object' || Array.isArray(session.spendByDay) || Object.keys(session.spendByDay).length) fields.push('spendByDay');
  if (session.velocity !== undefined) fields.push('velocity');
  if (session.metrics?.modelCalls !== 0 || !Array.isArray(session.models) || session.models.some((m: Row) => m.calls !== 0)) fields.push('modelCalls');
  if (mode === 'run-summary') {
    if (session.evidence?.fidelity !== 'summary' || session.evidence?.usageUnit !== 'run') fields.push('evidence.usageUnit');
    if (raw.perRequestBillingIdentities !== 0) fields.push('raw.requestGranularity');
  } else {
    if (raw.timestampFields !== 0 || raw.usageFields !== 0 || raw.modelFields !== 0) fields.push('raw.activityGranularity');
    if (session.firstEventAt !== null || session.lastEventAt !== null || session.metrics?.durationMilliseconds !== 0 || session.metrics?.eventSpanMilliseconds !== 0) fields.push('eventTiming');
    if (session.evidence?.timing !== 'file-mtime' || session.evidence?.tokens !== 'unavailable') fields.push('evidence.timing');
    if (!session.cost || Object.values(session.cost).some(v => v !== 0)) fields.push('cost');
  }
  return fields.map(field => ({ sessionKey: session.sessionKey, field: `time.${field}` }));
}
