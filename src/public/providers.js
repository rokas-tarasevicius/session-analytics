export const providerLabels = { codex: "Codex", claude: "Claude", cursor: "Cursor", copilot: "Copilot CLI", opencode: "OpenCode", gemini: "Gemini CLI" };
export const providerIds = Object.keys(providerLabels);
export const providerColors = { codex: "var(--codex)", claude: "var(--claude)", cursor: "var(--cursor)", copilot: "var(--cyan)", opencode: "var(--coral)", gemini: "var(--violet)" };

export function dailySpendByProvider(sessions, start, end) {
  const days = new Map();
  const empty = (name) => ({ name, ...Object.fromEntries(providerIds.map((provider) => [provider, 0])) });
  const first = new Date(`${start}T00:00:00Z`), last = new Date(`${end}T00:00:00Z`);
  for (let day = first, count = 0; day <= last && count < 3660; day = new Date(day.valueOf() + 86400000), count++) {
    const name = day.toISOString().slice(0, 10); days.set(name, empty(name));
  }
  for (const session of sessions) for (const [day, value] of Object.entries(session.spendByDay)) {
    if (day < start || day > end || !providerIds.includes(session.provider)) continue;
    const item = days.get(day) ?? empty(day); item[session.provider] += value; days.set(day, item);
  }
  return [...days.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function providerMark(provider) {
  if (["codex", "claude", "cursor"].includes(provider)) {
    const image = document.createElement("img"); image.src = `/brands/${provider}.svg`; image.alt = ""; return image;
  }
  const badge = document.createElement("span"); badge.className = "pill"; badge.textContent = { copilot: "CP", opencode: "OC", gemini: "G" }[provider]; badge.setAttribute("aria-hidden", "true"); return badge;
}

const sourceLabels = { "conductor-result": "Conductor results", "cursor-sdk": "Cursor SDK runs", "cursor-transcript": "Cursor transcripts", "copilot-events": "Copilot events", "opencode-db": "OpenCode database", "gemini-chat": "Gemini chats" };

/** Coverage uses eligible sessions, not invented zero-valued observations. */
export function providerEvidenceRows(sessions) {
  const groups = new Map();
  for (const session of sessions) {
    const source = session.evidence?.source ?? `${session.provider}-canonical`;
    const key = `${session.provider}:${source}`;
    const row = groups.get(key) ?? { provider: session.provider, source: sourceLabels[source] ?? `${providerLabels[session.provider]} history`, sessions: 0, tokenSessions: 0, toolSessions: 0, fileTimes: 0, fidelity: session.evidence?.fidelity ?? "message" };
    row.sessions++;
    if (session.evidence ? session.evidence.tokens === "reported" : session.tokens.inputTokens + session.tokens.outputTokens > 0) row.tokenSessions++;
    if (session.evidence?.tools !== "unavailable") row.toolSessions++;
    if (session.evidence?.timing === "file-mtime") row.fileTimes++;
    groups.set(key, row);
  }
  return [...groups.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.source.localeCompare(b.source));
}

export function renderProviderEvidence(container, sessions) {
  container.replaceChildren();
  const labels = { message: "Message evidence", summary: "Summary only", "activity-only": "Activity only" };
  for (const item of providerEvidenceRows(sessions)) {
    const row = document.createElement("tr");
    const fields = [providerLabels[item.provider], item.source, labels[item.fidelity], String(item.sessions), `${item.tokenSessions}/${item.sessions} sessions`, `${item.toolSessions}/${item.sessions} sessions`, item.fileTimes ? "File modified · start unknown" : "Provider timestamps"];
    for (const value of fields) { const cell = document.createElement("td"); cell.textContent = value; row.append(cell); }
    container.append(row);
  }
}
