import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ProviderAdapter } from "./adapter.ts";
import { addUsage, count, emptySession, files, finish, increment, jsonLines, modelName, name, observeTime, readJson, record, text, timestamp, tokens, type RecordValue } from "./common.ts";

interface Message {
  id: string; type: string; at: string | null; model: string;
  usage: ReturnType<typeof tokens> | null; tools: Array<{ id: string; name: string }>;
}

/** Discard content immediately; JSONL checkpoints/rewinds retain only this projection. */
function projectMessage(raw: unknown): Message | null {
  const message = record(raw), id = text(message?.["id"]);
  if (!message || !id || !["user", "gemini"].includes(String(message["type"]))) return null;
  const usage = record(message["tokens"]);
  const calls = Array.isArray(message["toolCalls"]) ? message["toolCalls"] : [];
  return { id, type: String(message["type"]), at: timestamp(message["timestamp"]), model: modelName(message["model"]),
    // Gemini candidatesTokenCount excludes thoughtsTokenCount; output pricing includes both.
    usage: usage ? tokens(usage["input"], usage["cached"], 0, count(usage["output"]) + count(usage["thoughts"]), usage["thoughts"], true) : null,
    tools: calls.flatMap((raw) => { const c = record(raw), tool = name(c?.["name"]), id = text(c?.["id"]); return tool && id ? [{ name: tool, id }] : []; }) };
}

async function header(path: string): Promise<RecordValue | null> {
  if (path.endsWith(".json")) return readJson(path);
  for await (const row of jsonLines(path)) if (text(row?.["sessionId"]) && text(row?.["projectHash"])) return row;
  return null;
}

export function geminiAdapter(knownPaths: string[] = []): ProviderAdapter {
  return {
    id: "gemini-chat", provider: "gemini",
    async discoverRoots({ home, options }) { return [options.geminiRoot ?? join(home, ".gemini/tmp")]; },
    async *identify(root) {
      const registry = record((await readJson(join(dirname(root), "projects.json")))?.["projects"]);
      const directories = new Map<string, string[]>();
      const assign = (key: string, path: string): void => { directories.set(key, [...new Set([...(directories.get(key) ?? []), path])]); };
      for (const path of knownPaths) assign(createHash("sha256").update(path).digest("hex"), path);
      for (const [path, slug] of Object.entries(registry ?? {})) {
        if (!path.startsWith("/") || typeof slug !== "string" || !/^[a-z0-9-]+$/.test(slug)) continue;
        assign(slug, path); assign(createHash("sha256").update(path).digest("hex"), path);
      }
      const paths: string[] = [];
      for await (const path of files(root, (p) => /\/chats\/session-[^/]+\.jsonl?$/.test(p))) paths.push(path);
      // During migration both formats can coexist; the append-only format is canonical.
      paths.sort((a, b) => Number(b.endsWith(".jsonl")) - Number(a.endsWith(".jsonl")) || a.localeCompare(b));
      const checkedMarkers = new Set<string>();
      for (const path of paths) {
        const metadata = await header(path), id = text(metadata?.["sessionId"]), project = text(metadata?.["projectHash"]);
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
        yield { id, path, cwd, createdAt, updatedAt: timestamp(metadata?.["lastUpdated"]) ?? createdAt, group: project };
      }
    },
    async analyze(identity, context) {
      const session = emptySession(identity, "gemini", context, { source: "gemini-chat", fidelity: "message", tokens: "unavailable", tools: "observed", turns: "observed", timing: "provider", usageUnit: "request" });
      const messages = new Map<string, Message>();
      const replace = (raw: unknown): void => { const message = projectMessage(raw); if (message) messages.set(message.id, message); };
      const applyMetadata = (metadata: RecordValue): void => {
        const at = timestamp(metadata["lastUpdated"]); if (at) session.updatedAt = at;
        if (metadata["kind"] === "subagent") session.executionKind = "subagent";
        else if (metadata["kind"] === "main") session.executionKind = "top-level";
        if (Array.isArray(metadata["messages"])) { messages.clear(); metadata["messages"].forEach(replace); }
      };
      if (identity.path.endsWith(".json")) {
        const data = await readJson(identity.path);
        if (data?.["sessionId"] !== identity.id || !Array.isArray(data["messages"])) return null;
        applyMetadata(data);
      } else {
        for await (const row of jsonLines(identity.path)) {
          if (!row) { session.transcript.warnings.push("Malformed Gemini records were skipped."); continue; }
          if (row["sessionId"] === identity.id) applyMetadata(row);
          else if (record(row["$set"])) applyMetadata(record(row["$set"])!);
          else if (typeof row["$rewindTo"] === "string") {
            const keys = [...messages.keys()], index = keys.indexOf(row["$rewindTo"]);
            for (const id of index < 0 ? keys : keys.slice(index)) messages.delete(id);
          } else if (record(row["$patch"])) {
            const patch = record(row["$patch"])!;
            if (Array.isArray(patch["removeIds"])) for (const id of patch["removeIds"]) if (typeof id === "string") messages.delete(id);
            if (Array.isArray(patch["orderIds"])) {
              const ordered = new Map<string, Message>();
              for (const id of patch["orderIds"]) if (typeof id === "string" && messages.has(id)) ordered.set(id, messages.get(id)!);
              for (const [id, message] of messages) if (!ordered.has(id)) ordered.set(id, message);
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
        session.metrics.assistantMessages++;
        if (message.usage) { session.evidence!.tokens = "reported"; addUsage(session, context, message.model, message.usage, message.at, "request"); }
        for (const tool of message.tools) if (!seenTools.has(tool.id)) { seenTools.add(tool.id); increment(session.tools, tool.name); }
      }
      session.transcript.warnings.push("Gemini metrics describe retained chat history; rewound or removed messages are excluded. Models without reviewed rates remain unpriced.");
      return finish(session);
    },
  };
}
