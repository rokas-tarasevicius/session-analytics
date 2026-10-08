import type { TranscriptHealth } from "../types.ts";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};

/** File identity and content version; a version change during a read marks the session partial. */
export interface FileVersion { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }
export const sameVersion = (a: FileVersion, b: FileVersion): boolean => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

/** Liveness is a bounded observation, never an inference from total starts minus completions. */
export class TranscriptLifecycle {
  private state: "open" | "closed" | "unknown" = "unknown";
  private timestamp = NaN;
  observe(provider: "claude" | "codex", row: RecordValue): void {
    let state: typeof this.state | undefined;
    const payload = record(row["payload"]), message = record(row["message"]);
    if (provider === "codex" && row["type"] === "event_msg") {
      if (["task_started", "user_message"].includes(String(payload["type"]))) state = "open";
      if (["task_complete", "turn_aborted"].includes(String(payload["type"]))) state = "closed";
    }
    if (provider === "claude") {
      if (row["type"] === "user") state = "open";
      if (row["type"] === "assistant") state = ["end_turn", "stop_sequence"].includes(String(message["stop_reason"])) ? "closed" : "open";
      if (row["type"] === "system" && row["subtype"] === "turn_duration") state = "closed";
    }
    if (state) { this.state = state; this.timestamp = typeof row["timestamp"] === "string" ? Date.parse(row["timestamp"]) : NaN; }
  }
  liveness(now = Date.now()): NonNullable<TranscriptHealth["liveness"]> {
    if (this.state === "closed") return "inactive";
    // A stale unmatched start may be interrupted or abandoned. It is not proof of current work.
    if (this.state === "open" && now >= this.timestamp && now - this.timestamp <= 15 * 60_000) return "active";
    return "unknown";
  }
}
