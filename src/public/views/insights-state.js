export const storageKey = "session-analytics-insights-v1";
export const snoozeMilliseconds = 7 * 86_400_000;

const decisionId = (id) => /^insight-(?:rule-)?[a-f0-9]{20}$/.test(id);

/** Scope IDs retain v1 decisions; rule IDs hide all scopes across refreshes/filters. */
export function readDecisions(storage, now = Date.now()) {
  try {
    const parsed = JSON.parse(storage.getItem(storageKey) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([key, value]) =>
      decisionId(key) && (value === "dismissed" || (Number.isFinite(value) && value > now)),
    ).slice(-2000));
  } catch { return {}; }
}

export function saveDecision(storage, decisions, id, action, now = Date.now()) {
  if (!decisionId(id) || !["restore", "snooze", "dismiss"].includes(action)) return { decisions, persisted: false };
  const next = { ...decisions };
  if (action === "restore") delete next[id];
  else if (action === "snooze") next[id] = now + snoozeMilliseconds;
  else if (action === "dismiss") next[id] = "dismissed";
  try { storage.setItem(storageKey, JSON.stringify(next)); return { decisions: next, persisted: true }; }
  catch { return { decisions: next, persisted: false }; }
}
