export const storageKey = "session-analytics-insights-v1";
export const snoozeMilliseconds = 7 * 86_400_000;

/** Store only opaque card IDs and expiry timestamps. Corrupt or unavailable storage is harmless. */
export function readDecisions(storage, now = Date.now()) {
  try {
    const parsed = JSON.parse(storage.getItem(storageKey) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([key, value]) =>
      /^insight-[a-f0-9]{20}$/.test(key) && (value === "dismissed" || (Number.isFinite(value) && value > now)),
    ).slice(-2000));
  } catch { return {}; }
}

export function saveDecision(storage, decisions, id, action, now = Date.now()) {
  if (!/^insight-[a-f0-9]{20}$/.test(id)) return { decisions, persisted: false };
  const next = { ...decisions };
  if (action === "restore") delete next[id];
  else if (action === "snooze") next[id] = now + snoozeMilliseconds;
  else if (action === "dismiss") next[id] = "dismissed";
  try { storage.setItem(storageKey, JSON.stringify(next)); return { decisions: next, persisted: true }; }
  catch { return { decisions: next, persisted: false }; }
}
