import { stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import type { ProviderAdapter } from "./adapter.ts";
import { emptySession, files, finish, increment, jsonLines, name, record, text } from "./common.ts";

const encode = (path: string): string => resolve(path).replace(/^\//, "").replace(/[^A-Za-z0-9]/g, "-");

/** Encoded directory names are matched only against known paths, never decoded by guessing. */
export function cursorTranscriptAdapter(knownPaths: string[] = []): ProviderAdapter {
  return {
    id: "cursor-transcript", provider: "cursor",
    async discoverRoots({ home, options }) { return [options.cursorTranscriptRoot ?? join(home, ".cursor/projects")]; },
    async *identify(root, onWarning) {
      for await (const path of files(root, (p) => p.endsWith(".jsonl") && p.includes("/agent-transcripts/"), 0, onWarning)) {
        try {
        const id = basename(path, ".jsonl");
        if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)) continue;
        const project = relative(root, path).split("/")[0];
        if (!project) continue;
        const matches = [...new Set(knownPaths.filter((p) => encode(p) === project))];
        const at = (await stat(path)).mtime.toISOString();
        yield { id, path, cwd: matches.length === 1 ? matches[0]! : null, createdAt: at, updatedAt: at, group: project };
        } catch (error) { if (!onWarning) throw error; onWarning("A Cursor transcript could not be read; sibling histories were retained."); }
      }
    },
    async analyze(identity, context) {
      const session = emptySession(identity, "cursor", context, { source: "cursor-transcript", fidelity: "activity-only", tokens: "unavailable", tools: "observed", turns: "observed", timing: "file-mtime", usageUnit: "unavailable" });
      // Cursor's writer uses this hierarchy only for a subagent with a known parent.
      // Ordinary/legacy paths do not establish top-level execution.
      const parts = identity.path.split("/");
      if (parts.at(-4) === "agent-transcripts" && parts.at(-2) === "subagents" && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(parts.at(-3) ?? "")) session.executionKind = "subagent";
      const seen = new Set<string>();
      for await (const row of jsonLines(identity.path)) {
        if (!row) { session.transcript.warnings.push("Malformed Cursor transcript records were skipped."); continue; }
        const message = record(row["message"]), content = message?.["content"];
        const blocks = Array.isArray(content) ? content : [];
        if (row["role"] === "user" && (typeof content === "string" || blocks.some((b) => record(b)?.["type"] === "text"))) session.metrics.userTurns++;
        if (row["role"] !== "assistant") continue;
        session.metrics.assistantMessages++;
        for (const raw of blocks) {
          const block = record(raw);
          if (block?.["type"] !== "tool_use") continue;
          const tool = name(block["name"]), id = text(block["id"]);
          if (!tool || (id && seen.has(id))) continue;
          if (id) seen.add(id);
          increment(session.tools, tool);
        }
      }
      if (!session.metrics.userTurns && !session.metrics.assistantMessages) return null;
      session.transcript.warnings.push("Activity-only Cursor transcript: tokens, model, cost, and event times are unavailable. The displayed date is the file modification time, not session start; duration is unavailable.");
      return finish(session);
    },
  };
}
