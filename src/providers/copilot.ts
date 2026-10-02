import { basename, dirname, join } from "node:path";
import type { ProviderAdapter } from "./adapter.ts";
import { emptySession, files, finish, increment, jsonLines, name, observeTime, record, text, timestamp } from "./common.ts";

/** Persisted activity events, verified against github/copilot-sdk's generated session event schema. */
export const copilotAdapter: ProviderAdapter = {
  id: "copilot-events", provider: "copilot",
  async discoverRoots({ home, options }) { return [options.copilotRoot ?? join(home, ".copilot/session-state")]; },
  async *identify(root) {
    for await (const path of files(root, (p) => basename(p) === "events.jsonl")) {
      for await (const event of jsonLines(path)) {
        if (event?.["type"] !== "session.start") continue;
        const data = record(event["data"]), id = text(data?.["sessionId"]), cwd = text(record(data?.["context"])?.["cwd"]);
        const createdAt = timestamp(data?.["startTime"]) ?? timestamp(event["timestamp"]);
        if (id === basename(dirname(path)) && id && cwd?.startsWith("/") && createdAt) yield { id, path, cwd, createdAt, updatedAt: createdAt };
        break;
      }
    }
  },
  async analyze(identity, context) {
    const session = emptySession(identity, "copilot", context, { source: "copilot-events", fidelity: "activity-only", tokens: "unavailable", tools: "observed", turns: "observed", timing: "provider", usageUnit: "unavailable" });
    const seen = new Set<string>(), calls = new Set<string>(), messages = new Set<string>();
    for await (const event of jsonLines(identity.path)) {
      if (!event) { session.transcript.warnings.push("Malformed Copilot events were skipped."); continue; }
      const id = text(event["id"]), data = record(event["data"]);
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      observeTime(session, event["timestamp"]);
      const type = event["type"];
      if (type === "user.message") session.metrics.userTurns++;
      if (type === "assistant.message") {
        const message = text(data?.["messageId"]) ?? id;
        if (message && !messages.has(message)) { session.metrics.assistantMessages++; messages.add(message); }
      }
      if (type === "assistant.turn_start") session.metrics.taskStarts++;
      if (type === "assistant.turn_end") session.metrics.taskCompletions++;
      if (type === "session.compaction_complete" && data?.["success"] === true) session.metrics.compactions++;
      if (type === "tool.execution_start") {
        const call = text(data?.["toolCallId"]), tool = name(data?.["toolName"]);
        if (call && tool && !calls.has(call)) { calls.add(call); increment(session.tools, tool); }
      }
    }
    session.updatedAt = session.lastEventAt ?? identity.updatedAt;
    session.transcript.warnings.push("Copilot persisted events provide activity counts. Per-call usage events are ephemeral; tokens and USD value are unavailable. Premium-request multipliers and AI credits are not dollar costs.");
    return finish(session);
  },
};
