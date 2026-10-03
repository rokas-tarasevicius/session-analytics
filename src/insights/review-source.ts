import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";

/** Worker-internal only. Never serialized into the analytics or review output. */
export interface ReviewSource {
  provider: "claude" | "codex";
  id: string;
  cwd: string;
  version: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const sameVersion = (a: ReviewSource["version"], b: ReviewSource["version"]): boolean => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const changed = () => new Error("Review evidence changed or its identity could not be verified. Retry after the session is inactive.");

export async function captureReviewSource(path: string, provider: ReviewSource["provider"]): Promise<ReviewSource> {
  const info = await stat(path);
  if (!info.isFile() || info.size > 256_000_000) throw new Error("Review evidence exceeds the bounded read limit.");
  const version = { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
  const input = createReadStream(path, { encoding: "utf8" }), lines = createInterface({ input, crlfDelay: Infinity });
  let id: unknown, cwd: unknown;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      if (line.length > 1_000_000) throw changed();
      let row: Record<string, unknown>;
      try { row = record(JSON.parse(line)); } catch { throw changed(); }
      if (provider === "codex" && row["type"] !== "session_meta") continue;
      const metadata = provider === "codex" ? record(row["payload"]) : row;
      id ??= metadata[provider === "codex" ? "id" : "sessionId"];
      cwd ??= metadata["cwd"];
      if (typeof id === "string" && typeof cwd === "string") break;
    }
  } finally { lines.close(); input.destroy(); }
  if (typeof id !== "string" || !id || typeof cwd !== "string" || !cwd || !sameVersion(version, await stat(path))) throw changed();
  return { provider, id, cwd, version };
}

export async function verifyReviewSource(path: string, source: ReviewSource): Promise<void> {
  const current = await captureReviewSource(path, source.provider);
  if (current.id !== source.id || current.cwd !== source.cwd || !sameVersion(current.version, source.version)) throw changed();
}
