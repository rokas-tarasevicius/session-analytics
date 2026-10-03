import type { ResolvedRate } from "../pricing/catalog.ts";
import type { AnalyzeOptions, CostBreakdown, ModelRate, RateCard, SessionAnalytics, SessionProvider, TokenUsage } from "../types.ts";

/** Everything in this interface is private to the analysis worker except analyze's result. */
export interface ProviderEnvironment {
  home: string;
  options: AnalyzeOptions;
  environment: NodeJS.ProcessEnv;
}

export interface ProviderSession {
  id: string;
  path: string;
  cwd: string | null;
  createdAt: string;
  updatedAt: string;
  /** Opaque grouping key for evidence without a trustworthy working directory. */
  group?: string;
}

export interface ProviderContext {
  repository: { id: string; name: string };
  rateCard: RateCard;
  resolveRate?: (model: string, at: string | null) => ResolvedRate | undefined;
  price: (rate: ModelRate, usage: TokenUsage, inputForRequest: number) => CostBreakdown;
}

/** Adapters own source discovery and identity; the host owns repository assignment and pricing. */
export interface ProviderAdapter<Session = ProviderSession, Context = ProviderContext> {
  readonly id: string;
  readonly provider: SessionProvider;
  discoverRoots(environment: ProviderEnvironment): Promise<string[]>;
  identify(root: string): AsyncIterable<Session>;
  analyze(session: Session, context: Context): Promise<SessionAnalytics | null>;
}
