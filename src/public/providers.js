export const providerLabels = { codex: "Codex", claude: "Claude", cursor: "Cursor", copilot: "Copilot CLI", opencode: "OpenCode", gemini: "Gemini CLI", unsupported: "Unsupported" };
export const providerIds = Object.keys(providerLabels);
export const providerColors = { codex: "var(--codex)", claude: "var(--claude)", cursor: "var(--cursor)", copilot: "var(--series-4)", opencode: "var(--series-5)", gemini: "var(--series-6)", unsupported: "var(--neutral-mark)" };

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
  const badge = document.createElement("span"); badge.className = "pill mark"; badge.textContent = { copilot: "CP", opencode: "OC", gemini: "G", unsupported: "?" }[provider]; badge.setAttribute("aria-hidden", "true"); return badge;
}

const sourceLabels = { "conductor-messages": "Conductor messages", "conductor-result": "Conductor results", "cursor-sdk": "Cursor SDK runs", "cursor-transcript": "Cursor transcripts", "copilot-events": "Copilot events", "opencode-db": "OpenCode database", "gemini-chat": "Gemini chats" };

/** Coverage uses eligible sessions, not invented zero-valued observations. */
export function providerEvidenceRows(sessions) {
  const groups = new Map();
  for (const session of sessions) {
    const source = session.evidence?.source ?? `${session.provider}-canonical`;
    const key = `${session.provider}:${source}`;
    const row = groups.get(key) ?? { provider: session.provider, source: sourceLabels[source] ?? `${providerLabels[session.provider]} history`, sessions: 0, tokenSessions: 0, toolSessions: 0, fileTimes: 0, partial: 0, fidelity: session.evidence?.fidelity ?? "message" };
    row.sessions++;
    if (session.evidence?.accounting === "partial") row.partial++;
    if (metricEligible(session, "tokens")) row.tokenSessions++;
    if (metricEligible(session, "tools")) row.toolSessions++;
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
    const fields = [providerLabels[item.provider], item.source, `${labels[item.fidelity]}${item.partial ? ` · ${item.partial}/${item.sessions} partial totals` : ""}`, String(item.sessions), `${item.tokenSessions}/${item.sessions} sessions`, `${item.toolSessions}/${item.sessions} sessions`, item.fileTimes ? "File modified · start unknown" : "Provider timestamps"];
    for (const value of fields) { const cell = document.createElement("td"); cell.textContent = value; row.append(cell); }
    container.append(row);
  }
}

/** Shared by terminal and browser consumers. Parsing success alone is not metric coverage. */
export function metricEligible(session, metric) {
  if (session.transcript && session.transcript.status !== "ok") return false;
  const evidence = session.evidence;
  switch (metric) {
    case "tokens": return evidence ? evidence.tokens === "reported" : session.tokens.inputTokens + session.tokens.outputTokens > 0;
    case "tools": return evidence ? evidence.tools === "observed" : true;
    case "turns": return evidence ? evidence.turns === "observed" : true;
    case "calls": return evidence ? evidence.usageUnit === "request" && evidence.tokens === "reported" : session.provider !== "cursor" && metricEligible(session, "tokens");
    case "compactions": return evidence ? ["copilot-events", "opencode-db"].includes(evidence.source) : session.provider !== "cursor";
    case "duration": return evidence?.timing !== "file-mtime";
    case "cost": return session.costBasis !== "unavailable" && (session.costBasis === "provider-reported" || session.pricedTokenCoverage > 0 || (metricEligible(session, "tokens") && session.costComplete));
    case "apiCost": return session.costBasis === "api-list-price-equivalent" && metricEligible(session, "cost");
    case "reportedCost": return session.costBasis === "provider-reported" && metricEligible(session, "cost");
    case "skills": return session.skillEvidence !== "unavailable";
    default: return false;
  }
}
export function metricCoverage(sessions, metric) {
  return { eligible: sessions.filter((s) => metricEligible(s, metric)).length, selected: sessions.length };
}
export function coveredValue(value, coverage, format = String) {
  if (!coverage.eligible) return "N/A";
  return `${format(value)}${coverage.eligible < coverage.selected ? ` · ${coverage.eligible}/${coverage.selected} sessions` : ""}`;
}
