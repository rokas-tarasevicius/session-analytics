import type { SessionAnalytics } from "../types.ts";
import type { ProviderAdapter, ProviderContext, ProviderEnvironment, ProviderSession } from "./adapter.ts";
import { copilotAdapter } from "./copilot.ts";
import { cursorSdkAdapter } from "./cursor-sdk.ts";
import { cursorTranscriptAdapter } from "./cursor-transcript.ts";
import { geminiAdapter } from "./gemini.ts";
import { opencodeAdapter } from "./opencode.ts";
import { hash } from "./common.ts";

interface AdditionalContext extends ProviderEnvironment {
  knownPaths: string[];
  existingSessions: SessionAnalytics[];
  pricing: Pick<ProviderContext, "rateCard" | "price" | "resolveRate">;
  repositoryForSession(identity: ProviderSession, source: string): Promise<ProviderContext["repository"]>;
}

/** Sources are ordered by fidelity. A lower-fidelity Cursor copy never adds another session. */
export async function additionalProviderSessions(context: AdditionalContext): Promise<{ sessions: SessionAnalytics[]; identities: Set<string>; warnings: string[] }> {
  const adapters: Array<[ProviderAdapter, string | undefined]> = [
    [cursorSdkAdapter, context.options.cursorSdkRoot],
    [opencodeAdapter, context.options.opencodeDatabasePath],
    [copilotAdapter, context.options.copilotRoot],
    [geminiAdapter(context.knownPaths), context.options.geminiRoot],
    [cursorTranscriptAdapter(context.knownPaths), context.options.cursorTranscriptRoot],
  ];
  const sessions: SessionAnalytics[] = [], warnings: string[] = [];
  const identities = new Set<string>();
  const seen = new Set(context.existingSessions.map((s) => s.sessionKey));
  for (const [adapter, explicit] of adapters) {
    if (context.options.additionalProviders === false && !explicit) continue;
    const roots = await adapter.discoverRoots(context);
    for (const root of roots) {
      try {
        for await (const identity of adapter.identify(root)) {
          const key = `${adapter.provider}:${identity.id}`;
          if (seen.has(hash(key))) { identities.add(key); continue; }
          try {
            const repository = await context.repositoryForSession(identity, adapter.id);
            const session = await adapter.analyze(identity, { repository, ...context.pricing });
            if (!session) continue;
            if (!identity.cwd) session.transcript.warnings.push("The evidence does not establish a unique repository path; this session is grouped as unassigned.");
            seen.add(hash(key)); identities.add(key); sessions.push(session);
          } catch { warnings.push("A provider evidence session could not be read; other sessions were retained."); }
        }
      } catch { warnings.push("A provider evidence store could not be read or has an unsupported schema."); }
    }
  }
  return { sessions, identities, warnings: [...new Set(warnings)] };
}
