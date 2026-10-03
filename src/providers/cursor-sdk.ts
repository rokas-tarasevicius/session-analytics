import { dirname, join } from "node:path";
import type { ProviderAdapter, ProviderSession } from "./adapter.ts";
import { addUsage, emptySession, files, finish, hasCounters, increment, jsonLines, modelName, name, statusName, observeTime, record, text, timestamp, tokens } from "./common.ts";

type Run = { model: string; usage: ReturnType<typeof tokens> | null; started: string | null; ended: string | null; updated: string; status: string };
type Projection = { runs: Map<string, Run>; tools: Record<string, number>; eventsAvailable: boolean; malformed: boolean };
// Identity-scoped, never a path cache: rescans see fresh data and completed stores can be collected.
const projections = new WeakMap<ProviderSession, Projection>();
async function projectStore(path: string, agents: Map<string, ProviderSession>): Promise<Map<string, Projection>> {
  const result = new Map<string, Projection>();
  for (const id of agents.keys()) result.set(id, { runs: new Map(), tools: {}, eventsAvailable: true, malformed: false });
  let malformed = false, runCount = 0;
  for await (const row of jsonLines(join(dirname(path), "runs.ndjson"))) {
    if (!row) { malformed = true; continue; }
    const agent = text(row["agentId"]), id = text(row["runId"]), projection = agent ? result.get(agent) : null;
    if (!id || !agent || !projection) continue;
    if (!projection.runs.has(id) && ++runCount > 100_000) throw new Error("Cursor SDK projection exceeds the memory budget.");
    const usage = record(row["usage"]);
    const run: Run = { model: modelName(record(row["model"])?.["id"]),
      usage: hasCounters(usage, ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"]) ? tokens(usage!["inputTokens"], usage!["cacheReadTokens"], usage!["cacheWriteTokens"], usage!["outputTokens"], usage!["reasoningTokens"]) : null,
      started: timestamp(row["startedAt"]), ended: timestamp(row["endedAt"]), updated: timestamp(row["updatedAt"]) ?? timestamp(row["endedAt"]) ?? timestamp(row["createdAt"]) ?? agents.get(agent)!.createdAt, status: name(row["status"]) ?? "unknown" };
    const previous = projection.runs.get(id);
    if (!previous || run.updated >= previous.updated) projection.runs.set(id, run);
  }
  const seen = new Set<string>();
  try {
    for await (const row of jsonLines(join(dirname(path), "run_events.ndjson"))) {
      const payload = record(row?.["payload"]), message = record(payload?.["message"]);
      if (payload?.["type"] !== "sdk_message" || message?.["type"] !== "tool_call") continue;
      const agent = text(message["agent_id"]), projection = agent ? result.get(agent) : null;
      const call = text(message["call_id"]), run = text(message["run_id"]), tool = name(message["name"]);
      if (!projection || !call || !run || !projection.runs.has(run) || !tool) continue;
      const key = JSON.stringify([agent, run, call]);
      if (seen.has(key)) continue;
      if (seen.size >= 200_000) throw new Error("Cursor SDK tool projection exceeds the memory budget.");
      seen.add(key); increment(projection.tools, tool);
    }
  } catch { for (const projection of result.values()) { projection.eventsAvailable = false; projection.tools = {}; } }
  for (const projection of result.values()) projection.malformed = malformed;
  return result;
}

export const cursorSdkAdapter: ProviderAdapter = {
  id: "cursor-sdk", provider: "cursor",
  async discoverRoots({ home, options }) { return [options.cursorSdkRoot ?? join(home, "Library/Application Support/com.conductor.app/cursor-sdk-store")]; },
  async *identify(root) {
    for await (const path of files(root, (p) => p.endsWith("/agents.ndjson"))) {
      const agents = new Map<string, ProviderSession>();
      for await (const raw of jsonLines(path)) {
        const id = text(raw?.["agentId"]), cwd = text(raw?.["cwd"]), createdAt = timestamp(raw?.["createdAt"]);
        if (id && cwd?.startsWith("/") && createdAt) agents.set(id, { id, cwd, path, createdAt, updatedAt: timestamp(raw?.["updatedAt"]) ?? createdAt });
        if (agents.size > 100_000) throw new Error("Cursor SDK identity projection exceeds the memory budget.");
      }
      if (!agents.size) continue;
      const store = await projectStore(path, agents);
      for (const identity of agents.values()) { projections.set(identity, store.get(identity.id)!); yield identity; }
    }
  },
  async analyze(identity, context) {
    const projection = projections.get(identity) ?? (await projectStore(identity.path, new Map([[identity.id, identity]]))).get(identity.id)!;
    const { runs } = projection;
    if (!runs.size) return null;
    const session = emptySession(identity, "cursor", context, { source: "cursor-sdk", fidelity: "summary", tokens: "unavailable", tools: projection.eventsAvailable ? "observed" : "unavailable", turns: "observed", timing: "provider", usageUnit: "run" });
    const latest = [...runs.values()].sort((a, b) => b.updated.localeCompare(a.updated))[0]!;
    session.status = latest.status === "finished" ? "completed" : latest.status === "running" ? "working" : latest.status === "queued" ? "pending" : statusName(latest.status);
    session.transcript.snapshotWhileWorking = session.status === "working";
    for (const run of runs.values()) {
      if (run.started) { session.metrics.userTurns++; session.metrics.taskStarts++; observeTime(session, run.started); }
      if (run.status === "finished") session.metrics.taskCompletions++;
      observeTime(session, run.ended);
      if (run.usage) { session.evidence!.tokens = "reported"; addUsage(session, context, run.model, run.usage, null, "summary", 0); }
    }
    session.tools = { ...projection.tools };
    session.transcript.files = projection.eventsAvailable ? 3 : 2;
    if (!projection.eventsAvailable) session.transcript.warnings.push("Cursor SDK tool events were unavailable; run summaries were retained.");
    if (projection.malformed) session.transcript.warnings.push("Malformed Cursor SDK records were skipped.");
    session.updatedAt = session.lastEventAt && session.lastEventAt > identity.updatedAt ? session.lastEventAt : identity.updatedAt;
    session.transcript.warnings.push("Cursor SDK usage is aggregated by run. Model request counts and daily cost attribution are unavailable; one started run counts as one observed turn.");
    return finish(session);
  },
};
