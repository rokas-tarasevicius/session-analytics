import { normalizeTimestamp } from "../public/timestamps.js";
import { projectModelId } from "../public/model-id.js";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";
import { hashPrefix, type FileFingerprint } from "./fingerprint.ts";

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
}
function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function codexCounterFingerprint(total: RecordValue | null, last: RecordValue | null): string | null {
  if (!total || !last) return null;
  return [total, last].flatMap((value) => [
    count(value["input_tokens"]), count(value["cached_input_tokens"]),
    count(value["output_tokens"]), count(value["reasoning_output_tokens"]),
  ]).join(":");
}

export interface CounterObservation {
  fingerprint: string;
  /** null encodes Infinity in the persisted JSON. */
  activityDeltaMilliseconds: number | null;
  timestamp: string;
}

/** This is the complete disk allowlist for the ledger, including append continuation state. */
export interface CodexLedgerEvidence {
  observations: CounterObservation[];
  models: string[];
  lastLocalActivityTimestamp: string | null;
  bytes: number;
  prefixHash: string | null;
  newlineTerminated: boolean;
  unownedCounters: boolean;
  unownedFingerprints: string[];
}

export async function readCodexLedger(
  path: string,
  current?: FileFingerprint,
  secret?: Uint8Array,
  previous?: { fingerprint: FileFingerprint; evidence: CodexLedgerEvidence },
): Promise<{ evidence: CodexLedgerEvidence; appended: boolean }> {
  const old = previous?.evidence;
  const appended = Boolean(current && secret && previous && old?.newlineTerminated && old.prefixHash &&
    previous.fingerprint.device === current.device && previous.fingerprint.inode === current.inode &&
    old.bytes === previous.fingerprint.size && current.size > old.bytes &&
    await hashPrefix(path, old.bytes, secret) === old.prefixHash);
  const models = new Set<string>(appended ? old?.models : []);
  const observations = new Map<string, CounterObservation>();
  for (const observation of appended ? old?.observations ?? [] : []) observations.set(observation.fingerprint, observation);
  let lastLocalActivityTimestamp = appended ? old?.lastLocalActivityTimestamp ?? null : null;
  let unownedCounters = appended ? old?.unownedCounters ?? false : false;
  const unownedFingerprints = new Set<string>(appended ? old?.unownedFingerprints : []);
  const input = createReadStream(path, { encoding: "utf8", start: appended ? old?.bytes ?? 0 : 0 });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let value: RecordValue | null;
      try { value = record(JSON.parse(line)); } catch { continue; }
      if (!value) continue;
      const payload = record(value["payload"]);
      const timestamp = normalizeTimestamp(value["timestamp"]);
      if (value["type"] === "turn_context") {
        const model = payload && Object.hasOwn(payload, "model") ? projectModelId(payload["model"]) : null;
        if (model) models.add(model);
      }
      const tokenEvent = value["type"] === "event_msg" && payload?.["type"] === "token_count";
      if (!tokenEvent) {
        if (value["type"] !== "session_meta" && value["type"] !== "turn_context" && timestamp) lastLocalActivityTimestamp = timestamp;
        continue;
      }
      const info = record(payload?.["info"]);
      const fingerprint = codexCounterFingerprint(record(info?.["total_token_usage"]), record(info?.["last_token_usage"]));
      if (fingerprint && !timestamp) { unownedCounters = true; unownedFingerprints.add(fingerprint); }
      if (!fingerprint || !timestamp) continue;
      const eventTime = Date.parse(timestamp), activityTime = Date.parse(lastLocalActivityTimestamp ?? "");
      const delta = Number.isFinite(eventTime) && Number.isFinite(activityTime) && eventTime >= activityTime
        ? eventTime - activityTime : Infinity;
      const previous = observations.get(fingerprint);
      if (!previous || delta < (previous.activityDeltaMilliseconds ?? Infinity) ||
        (delta === (previous.activityDeltaMilliseconds ?? Infinity) && timestamp < previous.timestamp)) {
        observations.set(fingerprint, { fingerprint, timestamp, activityDeltaMilliseconds: Number.isFinite(delta) ? delta : null });
      }
    }
  } finally { lines.close(); input.destroy(); }
  let newlineTerminated = false;
  if (current && current.size > 0) {
    const file = await open(path, "r");
    try {
      const tail = Buffer.alloc(1);
      await file.read(tail, 0, 1, current.size - 1);
      newlineTerminated = tail[0] === 10;
    } finally { await file.close(); }
  }
  return {
    appended,
    evidence: {
      observations: [...observations.values()], models: [...models], lastLocalActivityTimestamp,
      bytes: current?.size ?? 0, newlineTerminated, unownedCounters, unownedFingerprints: [...unownedFingerprints],
      prefixHash: current && secret ? await hashPrefix(path, current.size, secret) : null,
    },
  };
}
