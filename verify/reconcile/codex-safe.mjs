/** Privacy boundary for validation collectors; raw filesystem errors stay local. */
export function safeTimestamp(value) {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

export function safeModel(value, reviewedModels) {
  return typeof value === 'string' && Object.hasOwn(reviewedModels, value) ? value : '<unknown>';
}

export function safeCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function safeHash(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{12}$/.test(value)) throw new Error('Invalid hashed key');
  return value;
}

export function safeRepositoryKey(value) {
  return typeof value === 'string' && /^(?:conductor|discovered)-[a-f0-9]{12,64}$/.test(value) ? value : null;
}

export async function runPrivate(main) {
  const reportFailure = () => {
    process.stderr.write('{"status":"error","error":"codex-reconciliation-source-unavailable-or-invalid"}\n');
    process.exitCode = 1;
  };
  // Stream errors outside the awaited iterator must not print raw source paths.
  const fatal = () => { reportFailure(); process.exit(1); };
  process.once('uncaughtException', fatal);
  process.once('unhandledRejection', fatal);
  try { await main(); } catch { reportFailure(); }
  finally {
    process.removeListener('uncaughtException', fatal);
    process.removeListener('unhandledRejection', fatal);
  }
}
