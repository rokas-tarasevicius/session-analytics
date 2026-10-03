import type { SessionAnalytics } from "../types.ts";

export const canonicalMcpServer = (value: unknown): string | null => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : null;

/** Exact structured attribution wins. Legacy separators are resolved only when unambiguous. */
export function mcpAttribution(sessions: SessionAnalytics[], configured: readonly string[]): { used: Set<string>; ambiguous: Set<string> } {
  const used = new Set<string>(), ambiguous = new Set<string>();
  for (const session of sessions) {
    for (const [server, count] of Object.entries(session.insightSignals?.mcpServers ?? {})) if (count > 0 && configured.includes(server)) used.add(server);
    for (const [tool, count] of Object.entries(session.tools)) {
      if (count <= 0) continue;
      const canonical = tool.match(/^mcp__(.+?)__(.+)$/);
      if (canonical) { if (configured.includes(canonical[1]!)) used.add(canonical[1]!); continue; }
      const candidates = configured.filter((name) => tool.startsWith(`mcp_${name}_`) && tool.length > name.length + 5);
      if (candidates.length === 1 && tool.slice(4).split("_").length === 2) used.add(candidates[0]!);
      else for (const name of candidates) ambiguous.add(name);
    }
  }
  for (const name of used) ambiguous.delete(name);
  return { used, ambiguous };
}
