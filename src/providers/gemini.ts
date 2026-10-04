import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ProviderAdapter, ProviderSession } from "./adapter.ts";
import { addUsage, count, emptySession, files, finish, increment, jsonLines, modelName, name, observeTime, readJson, record, text, timestamp, tokens, type RecordValue } from "./common.ts";

interface Message {
  id: string; type: string; at: string | null; model: string;
  usage: ReturnType<typeof tokens> | null; tools: Array<{ id: string; name: string }>;
}

/** Discard content immediately; JSONL checkpoints/rewinds retain only this projection. */
function projectMessage(raw: unknown): Message | null {
  const message = record(raw), id = text(message?.["id"]);
  if (!message || !id) return null;
  // Keep every message identity as a replay anchor; only user/gemini contribute metrics.
  const usage = record(message["tokens"]);
  const calls = Array.isArray(message["toolCalls"]) ? message["toolCalls"] : [];
  if (calls.length > 1_000 || id.length > 512) throw new Error("Gemini message projection exceeds the memory budget.");
  return { id, type: String(message["type"]), at: timestamp(message["timestamp"]), model: modelName(message["model"]),
    // Gemini candidatesTokenCount excludes thoughtsTokenCount; output pricing includes both.
    usage: usage ? tokens(usage["input"], usage["cached"], 0, count(usage["output"]) + count(usage["thoughts"]), usage["thoughts"], true) : null,
    tools: calls.flatMap((raw) => { const c = record(raw), tool = name(c?.["name"]), id = text(c?.["id"]); return tool && id && id.length <= 512 ? [{ name: tool, id }] : []; }) };
}

const legacyByteLimit = 4 * 1024 * 1024;
const messageLimit = 20_000;
type Legacy = { metadata: RecordValue; messages: Message[] };
const legacyProjections = new WeakMap<ProviderSession, Legacy>();
async function legacyProjection(path: string): Promise<Legacy | null> {
  if ((await stat(path)).size > legacyByteLimit) throw new Error("Gemini legacy store exceeds the memory budget.");
  const data = await readJson(path);
  if (!data || !Array.isArray(data["messages"])) return null;
  if (data["messages"].length > messageLimit) throw new Error("Gemini replay exceeds the memory budget.");
  const metadata = Object.fromEntries(["sessionId", "projectHash", "startTime", "lastUpdated", "kind"].map((key) => [key, data[key]]));
  const messages = data["messages"].flatMap((raw) => { const message = projectMessage(raw); return message ? [message] : []; });
  if (messages.reduce((n, m) => n + m.tools.length, 0) > 50_000) throw new Error("Gemini tool projection exceeds the memory budget.");
  return { metadata, messages };
}
async function header(path: string): Promise<RecordValue | null> {
  // Resuming a JSONL session appends $set.sessionId; the initial header can be stale.
  const metadata: RecordValue = {};
  for await (const row of jsonLines(path, legacyByteLimit)) {
    if (!row) continue;
    const update = record(row["$set"]) ?? (text(row["sessionId"]) && text(row["projectHash"]) ? row : null);
    if (!update) continue;
    for (const key of ["sessionId", "projectHash", "startTime", "lastUpdated", "kind"]) {
      if (Object.hasOwn(update, key)) metadata[key] = update[key];
    }
  }
  return text(metadata["sessionId"]) && text(metadata["projectHash"]) ? metadata : null;
}

export function geminiAdapter(knownPaths: string[] = []): ProviderAdapter {
  return {
    id: "gemini-chat", provider: "gemini",
    async discoverRoots({ home, options }) { return [options.geminiRoot ?? join(home, ".gemini/tmp")]; },
    async *identify(root, onWarning) {
      let skippedFiles = false;
      const registry = record((await readJson(join(dirname(root), "projects.json")))?.["projects"]);
      const directories = new Map<string, string[]>();
      const assign = (key: string, path: string): void => { directories.set(key, [...new Set([...(directories.get(key) ?? []), path])]); };
      for (const path of knownPaths) assign(createHash("sha256").update(path).digest("hex"), path);
      for (const [path, slug] of Object.entries(registry ?? {})) {
        if (!path.startsWith("/") || typeof slug !== "string" || !/^[a-z0-9-]+$/.test(slug)) continue;
        assign(slug, path); assign(createHash("sha256").update(path).digest("hex"), path);
      }
      const paths: string[] = [];
      for await (const path of files(root, (p) => /\/chats\/session-[^/]+\.jsonl?$/.test(p), 0, onWarning)) paths.push(path);
      // During migration both formats can coexist; the append-only format is canonical.
      paths.sort((a, b) => Number(b.endsWith(".jsonl")) - Number(a.endsWith(".jsonl")) || a.localeCompare(b));
      const checkedMarkers = new Set<string>();
      for (const path of paths) {
        try {
        let legacy: Legacy | null = null;
        let metadata: RecordValue | null = null;
        try {
          legacy = path.endsWith(".json") ? await legacyProjection(path) : null;
          metadata = legacy?.metadata ?? (path.endsWith(".json") ? null : await header(path));
        } catch { skippedFiles = true; continue; }
        if (!metadata) { skippedFiles = true; continue; }
        const id = text(metadata["sessionId"]), project = text(metadata["projectHash"]);
        const createdAt = timestamp(metadata?.["startTime"]);
        if (!id || !project || !createdAt) continue;
        const projectDirectory = dirname(dirname(path)), key = basename(projectDirectory);
        if (!checkedMarkers.has(key)) {
          checkedMarkers.add(key);
          try {
            const marker = join(projectDirectory, ".project_root");
            if ((await stat(marker)).size <= 4096) {
              const owner = (await readFile(marker, "utf8")).trim();
              if (owner.startsWith("/")) assign(key, owner);
            }
          } catch { /* Older histories lack the primary-source ownership marker. */ }
        }
        const matches = directories.get(key) ?? directories.get(project) ?? [];
        const cwd = matches.length === 1 ? matches[0]! : null;
        // Old directories carry the project hash; new slugs need the primary-source registry mapping.
        if (/^[0-9a-f]{64}$/.test(key) && key !== project) continue;
        if (cwd && createHash("sha256").update(cwd).digest("hex") !== project) continue;
        const identity = { id, path, cwd, createdAt, updatedAt: timestamp(metadata?.["lastUpdated"]) ?? createdAt, group: project };
        if (legacy) legacyProjections.set(identity, legacy);
        yield identity;
        } catch (error) { if (!onWarning) throw error; onWarning("A Gemini history could not be read or exceeded its budget; sibling histories were retained."); }
      }
      // Report partial discovery only after all valid files have been yielded.
      if (skippedFiles) throw new Error("Some Gemini history files could not be read.");
    },
    async analyze(identity, context) {
      const session = emptySession(identity, "gemini", context, { source: "gemini-chat", fidelity: "message", tokens: "unavailable", tools: "observed", turns: "observed", timing: "provider", usageUnit: "request" });
      const messages = new Map<string, Message>();
      let retainedTools = 0;
      const remove = (id: string): void => { retainedTools -= messages.get(id)?.tools.length ?? 0; messages.delete(id); };
      const insert = (message: Message): void => {
        retainedTools += message.tools.length - (messages.get(message.id)?.tools.length ?? 0);
        messages.set(message.id, message);
        if (messages.size > messageLimit || retainedTools > 50_000) throw new Error("Gemini replay exceeds the memory budget.");
      };
      const replace = (raw: unknown): void => { const message = projectMessage(raw); if (message) insert(message); };
      const applyMetadata = (metadata: RecordValue): void => {
        const at = timestamp(metadata["lastUpdated"]); if (at) session.updatedAt = at;
        if (metadata["kind"] === "subagent") session.executionKind = "subagent";
        else if (metadata["kind"] === "main") session.executionKind = "top-level";
        if (Array.isArray(metadata["messages"])) { messages.clear(); retainedTools = 0; metadata["messages"].forEach(replace); }
      };
      if (identity.path.endsWith(".json")) {
        const legacy = legacyProjections.get(identity) ?? await legacyProjection(identity.path);
        if (!legacy || legacy.metadata["sessionId"] !== identity.id) return null;
        applyMetadata(legacy.metadata);
        for (const message of legacy.messages) insert(message);
      } else {
        for await (const row of jsonLines(identity.path, legacyByteLimit)) {
          if (!row) { session.evidence!.accounting = "partial"; session.transcript.warnings.push("Malformed or oversized Gemini records were skipped; accounting is partial."); continue; }
          if (text(row["sessionId"]) && text(row["projectHash"])) applyMetadata(row);
          else if (record(row["$set"])) applyMetadata(record(row["$set"])!);
          else if (typeof row["$rewindTo"] === "string") {
            const keys = [...messages.keys()], index = keys.indexOf(row["$rewindTo"]);
            for (const id of index < 0 ? keys : keys.slice(index)) remove(id);
          } else if (record(row["$patch"])) {
            const patch = record(row["$patch"])!;
            if (Array.isArray(patch["removeIds"])) for (const id of patch["removeIds"]) if (typeof id === "string") remove(id);
            if (Array.isArray(patch["orderIds"])) {
              const ordered = new Map<string, Message>();
              const requested = new Set(patch["orderIds"].filter((id): id is string => typeof id === "string"));
              for (const [id, message] of messages) if (!requested.has(id)) ordered.set(id, message);
              for (const id of requested) if (messages.has(id)) ordered.set(id, messages.get(id)!);
              messages.clear(); for (const [id, message] of ordered) messages.set(id, message);
            }
            // Content/tool-result patches have no metric fields.
          } else replace(row);
        }
      }
      const seenTools = new Set<string>();
      for (const message of messages.values()) {
        observeTime(session, message.at);
        if (message.type === "user") { session.metrics.userTurns++; continue; }
        if (message.type !== "gemini") continue;
        session.metrics.assistantMessages++;
        if (message.usage) { session.evidence!.tokens = "reported"; addUsage(session, context, message.model, message.usage, message.at, "request"); }
        for (const tool of message.tools) if (!seenTools.has(tool.id)) { seenTools.add(tool.id); increment(session.tools, tool.name); }
      }
      session.transcript.warnings.push("Gemini metrics describe retained chat history; rewound or removed messages are excluded. Models without reviewed rates remain unpriced.");
      const finalized = finish(session);
      if (session.evidence!.accounting === "partial") finalized.costComplete = false;
      return finalized;
    },
  };
}
