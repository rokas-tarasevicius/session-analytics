import { stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProviderAdapter, ProviderSession } from "./adapter.ts";
import { addUsage, emptySession, finish, increment, hash, modelName, name, observeTime, parse, record, text, timestamp, tokens } from "./common.ts";

// Forks get fresh message/part IDs but retain original message times and usage.
// Only compact fingerprints from messages owned by their creation session are indexed.
const ownerIndexes = new WeakMap<ProviderSession, Set<string>>();
function fingerprint(directory: string, message: Record<string, unknown>): string {
  const usage = record(message["tokens"]), cache = record(usage?.["cache"]), time = record(message["time"]);
  return hash(JSON.stringify([directory, timestamp(time?.["created"]), timestamp(time?.["completed"]), modelName(message["modelID"]), tokens(usage?.["input"], cache?.["read"], cache?.["write"], usage?.["output"], usage?.["reasoning"])]));
}
function indexOwners(database: DatabaseSync): Set<string> {
  const owners = new Set<string>();
  for (const row of database.prepare("SELECT s.directory, s.time_created, m.data FROM message m JOIN session s ON s.id=m.session_id").iterate()) {
    const message = parse(row["data"]), at = timestamp(record(message?.["time"])?.["created"]), created = timestamp(row["time_created"]);
    if (message?.["role"] !== "assistant" || !at || !created || at < created) continue;
    owners.add(fingerprint(String(row["directory"]), message));
    if (owners.size > 200_000) throw new Error("OpenCode ownership index exceeds the memory budget.");
  }
  return owners;
}

/** SQLite schema verified against anomalyco/opencode v1.2.24, session/session.sql.ts. */
export const opencodeAdapter: ProviderAdapter = {
  id: "opencode-db", provider: "opencode",
  async discoverRoots({ home, options, environment }) {
    return [options.opencodeDatabasePath ?? join(environment["XDG_DATA_HOME"] || join(home, ".local/share"), "opencode/opencode.db")];
  },
  async *identify(path) {
    try { await stat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const owners = indexOwners(database);
      for (const row of database.prepare("SELECT id, directory, time_created, time_updated FROM session ORDER BY id").iterate()) {
        const id = text(row["id"]), cwd = text(row["directory"]), createdAt = timestamp(row["time_created"]);
        if (id && cwd?.startsWith("/") && createdAt) {
          const identity = { id, cwd, path, createdAt, updatedAt: timestamp(row["time_updated"]) ?? createdAt };
          ownerIndexes.set(identity, owners); yield identity;
        }
      }
    } finally { database.close(); }
  },
  async analyze(identity, context) {
    const database = new DatabaseSync(identity.path, { readOnly: true });
    try {
      const session = emptySession(identity, "opencode", context, { source: "opencode-db", fidelity: "message", tokens: "unavailable", tools: "observed", turns: "observed", timing: "provider", usageUnit: "request" });
      const parent = database.prepare("SELECT parent_id FROM session WHERE id = ?").get(identity.id);
      session.executionKind = parent?.["parent_id"] ? "subagent" : "top-level";
      const owners = ownerIndexes.get(identity) ?? indexOwners(database);
      const excluded = new Set<string>();
      let inherited = 0, ambiguous = 0;
      const messages = new Map<string, { model: string; usage: ReturnType<typeof tokens> | null; at: string | null }>();
      for (const row of database.prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY id").iterate(identity.id)) {
        const message = parse(row["data"]);
        if (!message) { session.transcript.warnings.push("Malformed OpenCode message records were skipped."); continue; }
        const at = timestamp(record(message["time"])?.["created"]);
        if (!at || at < identity.createdAt) {
          excluded.add(String(row["id"]));
          if (message["role"] === "assistant") {
            if (at && owners.has(fingerprint(identity.cwd ?? "", message))) inherited++;
            else ambiguous++;
          }
          continue;
        }
        observeTime(session, at); observeTime(session, record(message["time"])?.["completed"]);
        if (message["role"] === "user") session.metrics.userTurns++;
        if (message["role"] !== "assistant") continue;
        session.metrics.assistantMessages++;
        const usage = record(message["tokens"]), cache = record(usage?.["cache"]);
        messages.set(String(row["id"]), { model: modelName(message["modelID"]), at,
          usage: usage ? tokens(usage["input"], cache?.["read"], cache?.["write"], usage["output"], usage["reasoning"]) : null });
      }
      const seen = new Set<string>();
      const stepped = new Set<string>();
      for (const row of database.prepare("SELECT message_id, time_created, data FROM part WHERE session_id = ? ORDER BY id").iterate(identity.id)) {
        if (excluded.has(String(row["message_id"]))) continue;
        const part = parse(row["data"]);
        if (part?.["type"] === "compaction") session.metrics.compactions++;
        // The assistant snapshot contains only its last step. Prefer per-step counters
        // when retained, and never add the assistant snapshot on top of those steps.
        if (part?.["type"] === "step-finish") {
          const messageId = String(row["message_id"]), message = messages.get(messageId), usage = record(part["tokens"]), cache = record(usage?.["cache"]);
          if (message && usage) {
            stepped.add(messageId); session.evidence!.tokens = "reported";
            addUsage(session, context, message.model, tokens(usage["input"], cache?.["read"], cache?.["write"], usage["output"], usage["reasoning"]), timestamp(row["time_created"]) ?? message.at, "request");
          }
        }
        if (part?.["type"] !== "tool") continue;
        const id = text(part["callID"]), tool = name(part["tool"]);
        if (!id || !tool || seen.has(id)) continue;
        seen.add(id); increment(session.tools, tool);
      }
      for (const [id, message] of messages) if (!stepped.has(id) && message.usage) {
        session.evidence!.tokens = "reported";
        addUsage(session, context, message.model, message.usage, message.at, "request");
      }
      if (inherited) session.transcript.warnings.push(`${inherited} inherited assistant records are owned by earlier sessions and excluded here.`);
      if (ambiguous) {
        session.evidence!.accounting = "partial";
        session.transcript.warnings.push(`${ambiguous} assistant records lack provable request ownership; their usage and cost are excluded. Accounting is partial.`);
      }
      session.transcript.warnings.push("OpenCode step counters are priced at reviewed API rates, with assistant snapshots used only where step counters are absent. OpenCode's own cost estimate is not added again.");
      const finalized = finish(session);
      if (ambiguous) finalized.costComplete = false;
      return finalized;
    } finally { database.close(); }
  },
};
