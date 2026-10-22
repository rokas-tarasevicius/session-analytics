import { stat } from "node:fs/promises";
import type { SessionAnalytics, SessionProvider } from "../types.ts";
import type { ProviderAdapter, ProviderContext, ProviderEnvironment, ProviderSession } from "./adapter.ts";
import { antigravityAdapter } from "./antigravity.ts";
import { copilotAdapter } from "./copilot.ts";
import { cursorSdkAdapter } from "./cursor-sdk.ts";
import { cursorTranscriptAdapter } from "./cursor-transcript.ts";
import { geminiAdapter } from "./gemini.ts";
import { opencodeAdapter } from "./opencode.ts";
import { hash } from "./common.ts";

interface AdditionalContext extends ProviderEnvironment {
  // Private work keys stay inside the analyzer; its public hook receives counters only.
  onDiscover?: (keys: Iterable<string>) => void;
  onProcessed?: (key: string) => void;
  knownPaths: string[];
  existingSessions: SessionAnalytics[];
  pricing: Pick<ProviderContext, "rateCard" | "price" | "resolveRate">;
  claimRequest?: ProviderContext["claimRequest"];
  completeRequests?: (session: SessionAnalytics) => void;
  reconcileAntigravityRequests?: Parameters<typeof antigravityAdapter>[0];
  repositoryForSession(identity: ProviderSession, source: string): Promise<ProviderContext["repository"]>;
}

/** Sources are ordered by fidelity. A lower-fidelity Cursor copy never adds another session. */
export async function additionalProviderSessions(context: AdditionalContext): Promise<{ sessions: SessionAnalytics[]; identities: Set<string>; warnings: string[]; sources: Map<SessionProvider, Array<string | null>> }> {
  const adapters: Array<[ProviderAdapter, string | undefined]> = [
    [cursorSdkAdapter, context.options.cursorSdkRoot],
    [opencodeAdapter, context.options.opencodeDatabasePath],
    [copilotAdapter, context.options.copilotRoot],
    [geminiAdapter(context.knownPaths), context.options.geminiRoot],
    [antigravityAdapter(context.reconcileAntigravityRequests), context.options.antigravityRoot],
    [cursorTranscriptAdapter(context.knownPaths), context.options.cursorTranscriptRoot],
  ];
  const sessions: SessionAnalytics[] = [], warnings: string[] = [];
  const sources = new Map<SessionProvider, Array<string | null>>();
  const identities = new Set<string>();
  const seen = new Set(context.existingSessions.map((s) => s.sessionKey));
  for (const [adapter, explicit] of adapters) {
    if (context.options.additionalProviders === false && !explicit) continue;
    context.onDiscover?.([]);
    const roots = await adapter.discoverRoots(context);
    for (const root of roots) {
      let sourceWarning: string | null = null;
      const storeHealth: Array<string | null> = [];
      const warn = (warning: string): void => { warnings.push(warning); sourceWarning = warning; };
      try {
        try { await stat(root); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          warn("A provider transcript root is missing.");
          continue;
        }
        const copies = new Map<string, { identity: ProviderSession; modified: number }>();
        try { for await (const identity of adapter.identify(root, warn, (warning) => storeHealth.push(warning))) {
          let modified = 0; try { modified = (await stat(identity.path)).mtimeMs; } catch { /* Analyze reports unreadable evidence. */ }
          const prior = copies.get(identity.id);
          const preferredFormat = adapter.id === "gemini-chat" ? Number(identity.path.endsWith(".jsonl")) - Number(prior?.identity.path.endsWith(".jsonl")) : 0;
          if (!prior || preferredFormat > 0 || (preferredFormat === 0 && (identity.updatedAt > prior.identity.updatedAt || (identity.updatedAt === prior.identity.updatedAt && modified > prior.modified)))) copies.set(identity.id, { identity, modified });
        }
        } catch { warn("A provider evidence store could not be fully read; identified sessions were retained."); }
        const workKey = (identity: ProviderSession) => `${adapter.id}:${root}:${identity.id}`;
        context.onDiscover?.([...copies.values()].map(({ identity }) => workKey(identity)));
        for (const { identity } of copies.values()) {
          const key = `${adapter.provider}:${identity.id}`;
          try {
            if (seen.has(hash(key))) { identities.add(key); continue; }
            const repository = await context.repositoryForSession(identity, adapter.id);
            const session = await adapter.analyze(identity, { repository, ...context.pricing, claimRequest: context.claimRequest });
            if (!session) continue;
            context.completeRequests?.(session);
            if (!identity.cwd) session.transcript.warnings.push("The evidence does not establish a unique repository path; this session is grouped as unassigned.");
            seen.add(hash(key)); identities.add(key); sessions.push(session);
          } catch { warn("A provider evidence session could not be read; other sessions were retained."); }
          finally { context.onProcessed?.(workKey(identity)); }
        }
      } catch { warn("A provider evidence store could not be read or has an unsupported schema."); }
      finally {
        const health = sources.get(adapter.provider) ?? [];
        if (storeHealth.length && sourceWarning && !storeHealth.includes(sourceWarning)) storeHealth.push(sourceWarning);
        health.push(...(storeHealth.length ? storeHealth : [sourceWarning])); sources.set(adapter.provider, health);
      }
    }
  }
  return { sessions, identities, warnings: [...new Set(warnings)], sources };
}
