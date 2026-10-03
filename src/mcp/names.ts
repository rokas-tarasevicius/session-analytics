/** Strict metadata identifiers, never arbitrary text or paths. */
export function safeName(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
    ? value : null;
}

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

export function mcpServerName(tool: string, configured?: string[]): string | null {
  if (configured) {
    const normalized = tool.replace(/^functions\./, "");
    // Longest known prefix preserves embedded separators and avoids assigning
    // team__search's calls to team when both servers are configured.
    return configured.filter((name) => safeName(name) && normalized.startsWith(`mcp__${name}__`) &&
      safeName(normalized.slice(name.length + 7))).sort((a, b) => b.length - a.length)[0] ?? null;
  }
  const match = /^(?:functions\.)?mcp__([A-Za-z0-9][A-Za-z0-9._:-]*?)__/.exec(tool);
  return safeName(match?.[1]);
}
