import { dirname, join } from "node:path";
import type { ProviderAdapter, ProviderSession } from "./adapter.ts";
import { addUsage, emptySession, files, finish, hasCounters, increment, jsonLines, modelName, name, statusName, observeTime, record, text, timestamp, tokens } from "./common.ts";

type Run = { eventRecovered?: true; model: string; usage: ReturnType<typeof tokens> | null; started: string | null; ended: string | null; updated: string; status: string };
type Projection = { runs: Map<string, Run>; tools: Map<string, string>; eventsAvailable: boolean; malformed: boolean };
// Identity-scoped, never a path cache: rescans see fresh data and completed stores can be collected.
const projections = new WeakMap<ProviderSession, Projection>();
async function projectStore(path: string, agents: Map<string, ProviderSession>): Promise<Map<string, Projection>> {
  const result = new Map<string, Projection>();
  for (const id of agents.keys()) result.set(id, { runs: new Map(), tools: new Map(), eventsAvailable: true, malformed: false });
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
  let usageEventCount = 0;
  const eventUsage = new Map<Run, { usage: ReturnType<typeof tokens>; seen: Set<string> }>();
  try {
    for await (const row of jsonLines(join(dirname(path), "run_events.ndjson"))) {
      if (!row) { malformed = true; continue; }
      const payload = record(row?.["payload"]), message = record(payload?.["message"]);
      if (payload?.["type"] === "sdk_message" && message?.["type"] === "usage") {
        const agent = text(message["agent_id"]), runId = text(message["run_id"]);
        const run = agent && runId ? result.get(agent)?.runs.get(runId) : undefined;
        const raw = record(message["usage"]), seq = row?.["seq"];
        // Stable event identity is required: identical counters can be separate turns.
        // Missing final summaries mean completeness cannot be established, even for
        // terminal runs. These observations are always retained as partial accounting.
        const eventId = typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0 ? String(seq) : text(row?.["offset"]);
        if (run && !run.usage && raw && eventId && hasCounters(raw, ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"])) {
          let aggregate = eventUsage.get(run);
          if (!aggregate) { aggregate = { usage: tokens(0, 0, 0, 0), seen: new Set() }; eventUsage.set(run, aggregate); }
          if (!aggregate.seen.has(eventId)) {
            if (++usageEventCount > 100_000) throw new Error("Cursor SDK usage projection exceeds the memory budget.");
            aggregate.seen.add(eventId);
            const usage = tokens(raw["inputTokens"], raw["cacheReadTokens"], raw["cacheWriteTokens"], raw["outputTokens"], raw["reasoningTokens"]);
            for (const key of Object.keys(usage) as Array<keyof typeof usage>) aggregate.usage[key] += usage[key];
          }
        }
      }
      if (payload?.["type"] !== "sdk_message" || message?.["type"] !== "tool_call") continue;
      const agent = text(message["agent_id"]), projection = agent ? result.get(agent) : null;
      const call = text(message["call_id"]), run = text(message["run_id"]), tool = name(message["name"]);
      if (!projection || !call || !run || !projection.runs.has(run) || !tool) continue;
      const key = JSON.stringify([agent, run, call]);
      if (seen.has(key)) continue;
      if (seen.size >= 200_000) throw new Error("Cursor SDK tool projection exceeds the memory budget.");
      seen.add(key); projection.tools.set(key, tool);
    }
  } catch { for (const projection of result.values()) { projection.eventsAvailable = false; projection.tools.clear(); } }
  for (const [run, aggregate] of eventUsage) { run.usage = aggregate.usage; run.eventRecovered = true; }
  for (const projection of result.values()) projection.malformed = malformed;
  return result;
}

export const cursorSdkAdapter: ProviderAdapter = {
  id: "cursor-sdk", provider: "cursor",
  async discoverRoots({ home, options }) { return [options.cursorSdkRoot ?? join(home, "Library/Application Support/com.conductor.app/cursor-sdk-store")]; },
  async *identify(root, onWarning) {
    const combined = new Map<string, { identity: ProviderSession; projection: Projection }>();
    for await (const path of files(root, (p) => p.endsWith("/agents.ndjson"), 0, onWarning)) {
      try {
      const agents = new Map<string, ProviderSession>();
      for await (const raw of jsonLines(path)) {
        const id = text(raw?.["agentId"]), cwd = text(raw?.["cwd"]), createdAt = timestamp(raw?.["createdAt"]);
        if (id && cwd?.startsWith("/") && createdAt) agents.set(id, { id, cwd, path, createdAt, updatedAt: timestamp(raw?.["updatedAt"]) ?? createdAt });
        if (agents.size > 100_000) throw new Error("Cursor SDK identity projection exceeds the memory budget.");
      }
      if (!agents.size) continue;
      const store = await projectStore(path, agents);
      for (const identity of agents.values()) {
        const projection = store.get(identity.id)!, prior = combined.get(identity.id);
        if (!prior) { combined.set(identity.id, { identity, projection }); continue; }
        if (identity.createdAt < prior.identity.createdAt) prior.identity.createdAt = identity.createdAt;
        if (identity.updatedAt > prior.identity.updatedAt) { prior.identity.updatedAt = identity.updatedAt; prior.identity.cwd = identity.cwd; }
        for (const [id, run] of projection.runs) {
          const existing = prior.projection.runs.get(id);
          if (!existing || run.updated >= existing.updated) prior.projection.runs.set(id, run);
        }
        for (const [id, tool] of projection.tools) prior.projection.tools.set(id, tool);
        prior.projection.eventsAvailable &&= projection.eventsAvailable;
        prior.projection.malformed ||= projection.malformed;
      }
      } catch (error) { if (!onWarning) throw error; onWarning("A Cursor SDK store could not be read; sibling stores were retained."); }
    }
    for (const { identity, projection } of combined.values()) { projections.set(identity, projection); yield identity; }
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
      if (run.usage) { session.evidence!.tokens = "reported"; addUsage(session, context, run.model, run.usage, run.started ?? run.ended ?? run.updated, "summary", 0); }
    }
    for (const tool of projection.tools.values()) increment(session.tools, tool);
    session.transcript.files = projection.eventsAvailable ? 3 : 2;
    if (!projection.eventsAvailable) session.transcript.warnings.push("Cursor SDK tool events were unavailable; run summaries were retained.");
    if (projection.malformed) session.transcript.warnings.push("Malformed Cursor SDK records were skipped.");
    session.updatedAt = session.lastEventAt && session.lastEventAt > identity.updatedAt ? session.lastEventAt : identity.updatedAt;
    session.transcript.warnings.push("Cursor SDK usage is aggregated by run. Model request counts and daily cost attribution are unavailable; one started run counts as one observed turn.");
    const finished = finish(session);
    if ([...runs.values()].some((run) => run.eventRecovered)) {
      finished.evidence!.accounting = "partial";
      finished.costComplete = false;
      finished.transcript.warnings.push("Cursor SDK usage was recovered from partial stream events; final run counters were unavailable.");
    }
    return finished;
  },
};
