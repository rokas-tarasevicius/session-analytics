import { analyzeMachineSessions } from "../analyzer.ts";
import type { AnalyzeOptions } from "../types.ts";
import { loadInsightContext } from "./config.ts";
import { insightsForSnapshot } from "./service.ts";
import { prepareReview } from "./review-context.ts";
import type { ReviewPreview } from "./review-context.ts";
import { invokeReviewAgent } from "./review-agent.ts";
import type { ReviewAssessment } from "./review-agent.ts";

export interface ReviewRequest { options: AnalyzeOptions; sessionKey: string; via: "claude" | "codex"; sendContent: boolean }
export interface ReviewResult { preview: ReviewPreview; result: ReviewAssessment | null }

/** Only called in the capped review worker. Source paths and redacted excerpts never cross its output boundary. */
export async function reviewSession(request: ReviewRequest): Promise<ReviewResult> {
  if (!/^[a-f0-9]{12}$/.test(request.sessionKey) || !["claude", "codex"].includes(request.via) || typeof request.sendContent !== "boolean") throw new Error("Invalid review request.");
  const sources = new Set<string>();
  const context = await loadInsightContext(request.options);
  const snapshot = await analyzeMachineSessions(request.options, (session, path) => { if (session.sessionKey === request.sessionKey) sources.add(path); });
  const matches = snapshot.sessions.filter((s) => s.sessionKey === request.sessionKey);
  const session = matches[0];
  if (matches.length !== 1 || !session || session.provider === "cursor" || session.transcript.status !== "ok" || sources.size !== 1) throw new Error("No unique supported session matched the review key.");
  const report = insightsForSnapshot(snapshot, context);
  const prepared = await prepareReview([...sources][0]!, session, report.cards, request.via, context.thresholds.longContextInputTokens);
  if (!request.sendContent || !prepared.prompt) return { preview: prepared.preview, result: null };
  const result = await invokeReviewAgent(request.via, prepared.prompt, request.sendContent);
  return { preview: { ...prepared.preview, mode: "sent", note: "P3 opt-in: bounded redacted excerpts were sent through your own agent CLI. Only allowlisted assessment labels are returned. Redaction is best effort; provider retention and billing policies apply." }, result };
}
