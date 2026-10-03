import type { SessionProvider } from "../types.ts";
import type { McpSourceHealth } from "./types.ts";

/** Map discovery results before repository/session selection can erase them. */
export function sourceHealth(provider: SessionProvider, warnings: Array<string | null>): McpSourceHealth {
  const sourcesRead = warnings.filter((warning) => warning === null).length;
  const missingSources = warnings.filter((warning) => warning === "A provider transcript root is missing." || warning === "Cursor local session history is missing.").length;
  const unreadableSources = warnings.length - sourcesRead - missingSources;
  return { provider, sourcesRead, missingSources, unreadableSources,
    status: !sourcesRead ? "unavailable" : missingSources || unreadableSources ? "incomplete" : "available" };
}
