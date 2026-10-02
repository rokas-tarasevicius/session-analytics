import { dirname, join } from "node:path";
import type { ProviderAdapter, ProviderSession } from "./adapter.ts";
import { addUsage, emptySession, files, finish, hasCounters, increment, jsonLines, modelName, name, observeTime, record, text, timestamp, tokens } from "./common.ts";

export const cursorSdkAdapter: ProviderAdapter = {
  id: "cursor-sdk", provider: "cursor",
  async discoverRoots({ home, options }) { return [options.cursorSdkRoot ?? join(home, "Library/Application Support/com.conductor.app/cursor-sdk-store")]; },
  async *identify(root) {
    for await (const path of files(root, (p) => p.endsWith("/agents.ndjson"))) {
      const agents = new Map<string, ProviderSession>();
      for await (const raw of jsonLines(path)) {
        const id = text(raw?.["agentId"]), cwd = text(raw?.["cwd"]), createdAt = timestamp(raw?.["createdAt"]);
        if (id && cwd?.startsWith("/") && createdAt) agents.set(id, { id, cwd, path, createdAt, updatedAt: timestamp(raw?.["updatedAt"]) ?? createdAt });
      }
      yield* agents.values();
    }
  },
  async analyze(identity, context) {
    const session = emptySession(identity, "cursor", context, { source: "cursor-sdk", fidelity: "summary", tokens: "unavailable", tools: "observed", turns: "observed", timing: "provider", usageUnit: "run" });
    const runs = new Map<string, { model: string; usage: ReturnType<typeof tokens> | null; started: string | null; ended: string | null; updated: string; status: string }>();
    for await (const row of jsonLines(join(dirname(identity.path), "runs.ndjson"))) {
      if (!row) { session.transcript.warnings.push("Malformed Cursor SDK records were skipped."); continue; }
      const id = text(row["runId"]);
      if (!id || row["agentId"] !== identity.id) continue;
      const usage = record(row["usage"]);
      runs.set(id, { model: modelName(record(row["model"])?.["id"]),
        usage: hasCounters(usage, ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"]) ? tokens(usage!["inputTokens"], usage!["cacheReadTokens"], usage!["cacheWriteTokens"], usage!["outputTokens"], usage!["reasoningTokens"]) : null,
        started: timestamp(row["startedAt"]), ended: timestamp(row["endedAt"]), updated: timestamp(row["updatedAt"]) ?? timestamp(row["endedAt"]) ?? timestamp(row["createdAt"]) ?? identity.createdAt, status: name(row["status"]) ?? "unknown" });
    }
    if (!runs.size) return null;
    const latest = [...runs.values()].sort((a, b) => b.updated.localeCompare(a.updated))[0]!;
    session.status = latest.status === "finished" ? "completed" : latest.status === "running" ? "working" : ["queued", "failed", "cancelled"].includes(latest.status) ? latest.status : "unknown";
    session.transcript.snapshotWhileWorking = session.status === "working";
    for (const run of runs.values()) {
      if (run.started) { session.metrics.userTurns++; session.metrics.taskStarts++; observeTime(session, run.started); }
      if (run.status === "finished") session.metrics.taskCompletions++;
      observeTime(session, run.ended);
      if (run.usage) { session.evidence!.tokens = "reported"; addUsage(session, context, run.model, run.usage, null, "summary", 0); }
    }
    const seen = new Set<string>();
    try {
      for await (const row of jsonLines(join(dirname(identity.path), "run_events.ndjson"))) {
        const payload = record(row?.["payload"]), message = record(payload?.["message"]);
        if (payload?.["type"] !== "sdk_message" || message?.["agent_id"] !== identity.id || message["type"] !== "tool_call") continue;
        const call = text(message["call_id"]), run = text(message["run_id"]), tool = name(message["name"]);
        if (!call || !run || !runs.has(run) || !tool || seen.has(`${run}:${call}`)) continue;
        seen.add(`${run}:${call}`); increment(session.tools, tool);
      }
      session.transcript.files = 3;
    } catch {
      session.evidence!.tools = "unavailable";
      session.transcript.files = 2;
      session.transcript.warnings.push("Cursor SDK tool events were unavailable; run summaries were retained.");
    }
    session.updatedAt = session.lastEventAt && session.lastEventAt > identity.updatedAt ? session.lastEventAt : identity.updatedAt;
    session.transcript.warnings.push("Cursor SDK usage is aggregated by run. Model request counts and daily cost attribution are unavailable; one started run counts as one observed turn.");
    return finish(session);
  },
};
