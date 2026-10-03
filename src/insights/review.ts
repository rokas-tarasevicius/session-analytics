import { analyzeMachineSessions } from "../analyzer.ts";
import type { EvidenceObserver } from "../analyzer.ts";
import type { AnalyzeOptions } from "../types.ts";
import { loadInsightContext } from "./config.ts";
import { buildInsights } from "./engine.ts";
import { eligibleEvidence } from "./eligibility.ts";
import { verifyReviewSource } from "./review-source.ts";
import type { ReviewSource } from "./review-source.ts";
import type { Insight } from "./types.ts";
import { prepareReview } from "./review-context.ts";
import type { ReviewPreview } from "./review-context.ts";
import { invokeReviewAgent } from "./review-agent.ts";
import type { ReviewAssessment } from "./review-agent.ts";

export interface ReviewRequest { options: AnalyzeOptions; sessionKey: string; via: "claude" | "codex"; sendContent: boolean }
export interface ReviewResult { preview: ReviewPreview; result: ReviewAssessment | null }

/** Only called in the capped review worker. Source paths and redacted excerpts never cross its output boundary. */
export async function reviewSession(request: ReviewRequest): Promise<ReviewResult> {
  if (!/^[a-f0-9]{12}$/.test(request.sessionKey) || !["claude", "codex"].includes(request.via) || typeof request.sendContent !== "boolean") throw new Error("Invalid review request.");
  const sources = new Map<string, ReviewSource>();
  const context = await loadInsightContext(request.options);
  const observe: EvidenceObserver = (_session, path, source) => { sources.set(path, source); };
  observe.sessionKey = request.sessionKey;
  const snapshot = await analyzeMachineSessions(request.options, observe);
  const matches = snapshot.sessions.filter((s) => s.sessionKey === request.sessionKey);
  const session = matches[0];
  if (matches.length !== 1 || !session || session.provider === "cursor" || !eligibleEvidence(session) || sources.size !== 1) throw new Error("No unique eligible supported session matched the review key.");
  const cards: Insight[] = [];
  buildInsights(snapshot.sessions, context, snapshot.generatedAt, (card, contributors) => {
    if (card.scope.kind !== "machine" && contributors.some((s) => s.sessionKey === session.sessionKey)) cards.push(card);
  });
  const [path, source] = [...sources][0]!;
  const prepared = await prepareReview(path, session, cards, request.via, context.thresholds.longContextInputTokens, source);
  if (!request.sendContent || !prepared.prompt) return { preview: prepared.preview, result: null };
  await verifyReviewSource(path, source);
  const result = await invokeReviewAgent(request.via, prepared.prompt, request.sendContent);
  return { preview: { ...prepared.preview, mode: "sent", note: "P3 opt-in: bounded redacted excerpts were sent through your own agent CLI. Only allowlisted assessment labels are returned. Redaction is best effort; provider retention and billing policies apply." }, result };
}
