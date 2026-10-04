import { createHash } from "node:crypto";
import { normalizeTimestamp } from "../public/timestamps.js";
import { projectModelId } from "../public/model-id.js";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { readJsonLines } from "../jsonl-lines.ts";
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
  if (!total) return null;
  // All receivers of a cumulative-only endpoint must share one claim.
  return [total, last ?? {}].flatMap((value) => [
    count(value["input_tokens"]), count(value["cached_input_tokens"]),
    count(value["output_tokens"]), count(value["reasoning_output_tokens"]),
  ]).join(":");
}

export interface CounterObservation {
  fingerprint: string;
  /** First occurrence retained even when a later duplicate has closer activity. */
  earliestTimestamp?: string;
  /** null encodes Infinity in the persisted JSON. */
  activityDeltaMilliseconds: number | null;
  timestamp: string;
}

/** This is the complete disk allowlist for the ledger, including append continuation state. */
export interface CodexLedgerEvidence {
  nativeFingerprints?: string[];
  receipts?: Array<{ fingerprint: string; key: string; timestamp: string }>;
  identity?: { key: string; parents: string[]; createdAt: string | null };
  calls?: Array<{ key: string; timestamp: string | null }>;
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
  const appended = Boolean(current && secret && previous && old?.observations.every((observation) => typeof observation.earliestTimestamp === "string") && old?.newlineTerminated && old.prefixHash &&
    previous.fingerprint.device === current.device && previous.fingerprint.inode === current.inode &&
    old.bytes === previous.fingerprint.size && current.size > old.bytes &&
    await hashPrefix(path, old.bytes, secret) === old.prefixHash);
  const privateKey = (value: string): string => createHash("sha256").update(value).digest("hex");
  const receipts = new Map<string, { fingerprint: string; key: string; timestamp: string }>((appended ? old?.receipts ?? [] : []).map(value => [value.key, value]));
  let identity = appended ? old?.identity : undefined;
  const calls = new Map<string, string | null>((appended ? old?.calls ?? [] : []).map((call) => [call.key, call.timestamp]));
  const models = new Set<string>(appended ? old?.models : []);
  const observations = new Map<string, CounterObservation>();
  for (const observation of appended ? old?.observations ?? [] : []) observations.set(observation.fingerprint, observation);
  let lastLocalActivityTimestamp = appended ? old?.lastLocalActivityTimestamp ?? null : null;
  let unownedCounters = appended ? old?.unownedCounters ?? false : false;
  const unownedFingerprints = new Set<string>(appended ? old?.unownedFingerprints : []);
  const input = createReadStream(path, { encoding: "utf8", start: appended ? old?.bytes ?? 0 : 0 });
  const lines = readJsonLines(input);
  try {
    for await (const line of lines) {
      let value: RecordValue | null;
      try { value = record(JSON.parse(line)); } catch { continue; }
      if (!value) continue;
      const payload = record(value["payload"]);
      const timestamp = normalizeTimestamp(value["timestamp"]);
      if (value["type"] === "session_meta" && !identity) {
        const id = string(payload?.["id"]);
        if (id) {
          const source = record(payload?.["source"]), subagent = record(source?.["subagent"]);
          const parent = record(subagent?.["thread_spawn"]);
          identity = { key: privateKey(id), createdAt: normalizeTimestamp(payload?.["timestamp"]) ?? timestamp,
            parents: [string(payload?.["forked_from_id"]), string(parent?.["parent_thread_id"])].filter((id): id is string => Boolean(id)).map(privateKey) };
        }
      }
      if (value["type"] === "token_usage_record" || value["type"] === "event_msg" && payload?.["type"] === "token_usage_record") {
        const thread = string(payload?.["thread_id"]), response = string(payload?.["response_id"]);
        const usage = record(payload?.["usage"]), total = record(payload?.["thread_token_usage"]);
        if (thread && response && timestamp && identity?.key === privateKey(thread) && usage &&
            typeof usage["input_tokens"] === "number" && typeof usage["output_tokens"] === "number") {
          const key = `receipt:${createHash("sha256").update(JSON.stringify([thread, response])).digest("hex")}`;
          const fingerprint = codexCounterFingerprint(total, usage);
          if (fingerprint && !receipts.has(key)) receipts.set(key, { fingerprint, key, timestamp });
        }
      }
      if (value["type"] === "response_item" && ["function_call", "custom_tool_call"].includes(String(payload?.["type"]))) {
        const id = string(payload?.["call_id"]) ?? string(payload?.["id"]);
        if (id) { const key = privateKey(id), old = calls.get(key); if (!calls.has(key) || timestamp && (!old || timestamp < old)) calls.set(key, timestamp); }
      }
      if (value["type"] === "turn_context") {
        const model = payload && Object.hasOwn(payload, "model") ? projectModelId(payload["model"]) : null;
        if (model) models.add(model);
      }
      const tokenEvent = value["type"] === "event_msg" && payload?.["type"] === "token_count";
      if (!tokenEvent) {
        // Only generated model responses establish ownership. User messages and
        // tool receipts can arrive in a passive broadcast receiver.
        const type = value["type"], payloadType = payload?.["type"];
        const localResponse = type === "token_usage_record" ||
          (type === "response_item" && (
            payloadType === "function_call" || payloadType === "custom_tool_call" ||
            payloadType === "reasoning" ||
            (payloadType === "message" && payload?.["role"] === "assistant"))) ||
          (type === "event_msg" && (payloadType === "agent_message" || payloadType === "agent_reasoning" ||
            (payloadType === "item_completed" && record(payload?.["item"])?.["type"] === "AgentMessage")));
        if (localResponse && timestamp) lastLocalActivityTimestamp = timestamp;
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
      const first = previous?.earliestTimestamp ?? previous?.timestamp ?? timestamp;
      const earliestTimestamp = timestamp < first ? timestamp : first;
      if (!previous || delta < (previous.activityDeltaMilliseconds ?? Infinity) ||
        (delta === (previous.activityDeltaMilliseconds ?? Infinity) && timestamp < previous.timestamp)) {
        observations.set(fingerprint, { fingerprint, timestamp, earliestTimestamp, activityDeltaMilliseconds: Number.isFinite(delta) ? delta : null });
      } else {
        previous.earliestTimestamp = earliestTimestamp;
      }
    }
  } finally { input.destroy(); }
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
      nativeFingerprints: [...new Set([...receipts.values()].flatMap(value => [value.fingerprint, value.key]))], receipts: [...receipts.values()],
      ...(identity ? { identity } : {}), calls: [...calls].map(([key, timestamp]) => ({ key, timestamp })),
      observations: [...observations.values()], models: [...models], lastLocalActivityTimestamp,
      bytes: current?.size ?? 0, newlineTerminated, unownedCounters, unownedFingerprints: [...unownedFingerprints],
      prefixHash: current && secret ? await hashPrefix(path, current.size, secret) : null,
    },
  };
}
