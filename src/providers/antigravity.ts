import { lstat, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { openSourceDatabase } from "../source-database.ts";
import { VelocityAccumulator, velocityDimension } from "../metrics/velocity.ts";
import { projectModelId } from "../public/model-id.js";
import type { TokenUsage } from "../types.ts";
import type { ProviderAdapter, ProviderSession } from "./adapter.ts";
import { addUsage, emptySession, finish, increment, name, observeTime, timestamp, tokens } from "./common.ts";

const limit = 1024 * 1024, rowLimit = 100_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
import { antigravityWarnings } from "../public/provider-warnings.js";
export { antigravityWarnings };


type Field = { number: number; value: bigint | Uint8Array };
/** Only walk the requested metadata envelopes. Unknown length-delimited fields
 * stay byte slices; prompts, tool arguments and results are never decoded. */
function fields(raw: unknown): Field[] {
  if (!(raw instanceof Uint8Array) || raw.byteLength > limit) throw new Error("Invalid Antigravity metadata.");
  let offset = 0;
  const integer = (): bigint => {
    let value = 0n;
    for (let n = 0; n < 10 && offset < raw.length; n++) {
      const byte = raw[offset++]!;
      if (n === 9 && byte > 1) break;
      value |= BigInt(byte & 127) << BigInt(n * 7);
      if (!(byte & 128)) return value;
    }
    throw new Error("Invalid Antigravity varint.");
  };
  const output: Field[] = [];
  while (offset < raw.length) {
    const tag = integer(), number = Number(tag >> 3n), wire = Number(tag & 7n);
    if (!number || number > 536_870_911 || output.length > 20_000) throw new Error("Invalid Antigravity field.");
    if (wire === 0) { output.push({ number, value: integer() }); continue; }
    const size = wire === 1 ? 8 : wire === 5 ? 4 : wire === 2 ? Number(integer()) : NaN;
    if (!Number.isSafeInteger(size) || size < 0 || size > raw.length - offset) throw new Error("Invalid Antigravity field size.");
    if (wire === 2) output.push({ number, value: raw.subarray(offset, offset + size) });
    offset += size;
  }
  return output;
}
const values = (rows: Field[], number: number) => rows.filter((row) => row.number === number).map((row) => row.value);
function message(rows: Field[], number: number): Field[] | null {
  const parts = values(rows, number);
  return parts.length ? parts.flatMap(fields) : null; // Singular protobuf messages merge.
}
function counter(rows: Field[], number: number): number | null {
  let result: number | null = null;
  for (const value of values(rows, number)) {
    if (typeof value !== "bigint" || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Invalid Antigravity counter.");
    result = Number(value);
  }
  return result;
}
function string(rows: Field[], number: number): string | null {
  let result: string | null = null;
  for (const value of values(rows, number)) {
    if (!(value instanceof Uint8Array) || value.length > 4096) throw new Error("Invalid Antigravity identifier.");
    result = new TextDecoder("utf-8", { fatal: true }).decode(value) || null;
  }
  return result;
}
function identifier(rows: Field[], number: number): string | null {
  const value = string(rows, number);
  if (value && value.length > 512) throw new Error("Invalid Antigravity identifier.");
  return value;
}
function time(rows: Field[] | null): string | null {
  if (!rows) return null;
  const seconds = counter(rows, 1), nanos = counter(rows, 2) ?? 0;
  if (seconds === null || seconds > 253_402_300_799 || nanos > 999_999_999) throw new Error("Invalid Antigravity timestamp.");
  return timestamp(seconds * 1000 + Math.floor(nanos / 1_000_000));
}
interface Usage { usage: TokenUsage; reasoning: boolean; response: string | null; message: string | null; model: string }
function usage(rows: Field[] | null): Usage | null {
  if (!rows) return null;
  if (![2, 3, 4, 5, 9, 10].some((number) => values(rows, number).length)) return null;
  const input = counter(rows, 2) ?? 0, output = counter(rows, 3) ?? 0;
  const write = counter(rows, 4) ?? 0, read = counter(rows, 5) ?? 0, thinking = counter(rows, 9);
  if (!Number.isSafeInteger(input + read + write) || (thinking ?? 0) > output) throw new Error("Invalid Antigravity usage.");
  const observed = tokens(input, read, write, output, thinking ?? 0);
  if (thinking === null) observed.nonReasoningOutputTokens = 0;
  const model = counter(rows, 1);
  return { usage: observed, reasoning: thinking !== null, response: identifier(rows, 11), message: identifier(rows, 7), model: model ? `antigravity-model-${model}` : "<unknown>" };
}
function table(database: DatabaseSync, name: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
}
function workspace(metadata: Field[]): string | null {
  const workspaces = values(metadata, 1).map((value) => string(fields(value), 1));
  if (!workspaces.length) workspaces.push(string(metadata, 7));
  const paths = workspaces.map((value) => {
    if (!value) return null;
    if (value.startsWith("/")) return value;
    try {
      const url = new URL(value);
      return url.protocol === "file:" && !url.hostname && !url.search && !url.hash ? fileURLToPath(url) : null;
    } catch { return null; }
  });
  return paths.every(Boolean) && new Set(paths).size === 1 ? paths[0]! : null;
}
interface Projection { identity: ProviderSession; steps: Step[]; generations: Generation[]; partial: boolean; fork: boolean }
interface Step { index: number; type: number; at: string | null; execution: string | null; usage: Usage | null; tool: { id: string; name: string } | null }
interface Generation { index: number; at: string | null; execution: string | null; usage: Usage | null; model: string }

function projection(path: string): Projection | null {
  const database = openSourceDatabase(path);
  try {
    database.exec("PRAGMA busy_timeout=1500; BEGIN");
    if (database.prepare("PRAGMA user_version").get()?.["user_version"] !== 1) throw new Error("Unsupported Antigravity schema.");
    const owners = database.prepare("SELECT cascade_id FROM trajectory_meta").all();
    const id = basename(path, ".db");
    if (owners.length !== 1 || owners[0]?.["cascade_id"] !== id) return null;
    const raw = database.prepare("SELECT CASE WHEN length(data)<=? THEN data END AS data FROM trajectory_metadata_blob WHERE id='main'").get(limit)?.["data"];
    const metadata = raw === undefined ? [] : fields(raw);
    let partial = false;
    const steps: Step[] = [];
    for (const row of database.prepare("SELECT idx,step_type,CASE WHEN length(metadata)<=? THEN metadata END AS metadata FROM steps ORDER BY idx LIMIT ?").iterate(limit, rowLimit + 1)) {
      if (steps.length >= rowLimit) throw new Error("Antigravity step budget exceeded.");
      try {
        if (!Number.isSafeInteger(row["idx"]) || Number(row["idx"]) < 0) throw new Error("Invalid step index.");
        const meta = row["metadata"] === null ? [] : fields(row["metadata"]);
        const call = message(meta, 4), toolId = call ? identifier(call, 1) : null, toolName = call ? name(string(call, 2)) : null;
        steps.push({ index: Number(row["idx"]), type: Number(row["step_type"]), at: time(message(meta, 1)), execution: identifier(meta, 12), usage: usage(message(meta, 9)), tool: toolId && toolName ? { id: toolId, name: toolName } : null });
        if (row["metadata"] === null) partial = true;
      } catch { partial = true; }
    }
    const generations: Generation[] = [];
    if (table(database, "gen_metadata")) for (const row of database.prepare("SELECT idx,CASE WHEN length(data)<=? THEN data END AS data FROM gen_metadata ORDER BY idx LIMIT ?").iterate(limit, rowLimit + 1)) {
      if (generations.length >= rowLimit) throw new Error("Antigravity generation budget exceeded.");
      try {
        const root = fields(row["data"]), chat = message(root, 1);
        if (!chat || !Number.isSafeInteger(row["idx"])) throw new Error("Invalid generation metadata.");
        generations.push({ index: Number(row["idx"]), at: time(message(message(chat, 9) ?? [], 4)), execution: identifier(root, 4), usage: usage(message(chat, 4)), model: projectModelId(string(chat, 19)) });
      } catch { partial = true; }
    }
    // A present but damaged generation ledger must never fall back to its step mirror.
    const generationRows = table(database, "gen_metadata") ? Number(database.prepare("SELECT count(*) AS n FROM gen_metadata").get()?.["n"]) : 0;
    if (generationRows && !generations.length) partial = true;
    const dates = [...steps.map((s) => s.at), ...generations.map((g) => g.at)].filter((s): s is string => Boolean(s)).sort();
    const createdAt = time(message(metadata, 2)) ?? dates[0];
    if (!createdAt) return null;
    const fork = table(database, "parent_references") && Boolean(database.prepare("SELECT 1 FROM parent_references LIMIT 1").get());
    // Keep a sentinel generation so a corrupt canonical ledger cannot enable fallback.
    if (generationRows && !generations.length) generations.push({ index: -1, at: null, execution: null, usage: null, model: "<unknown>" });
    const result = { identity: { id, path, cwd: workspace(metadata), createdAt, updatedAt: dates.at(-1) ?? createdAt }, steps, generations, partial, fork };
    database.exec("COMMIT");
    return result;
  } finally { database.close(); }
}

/** Field map: CortexStepMetadata.9 / ChatModelMetadata.4 = ModelUsageStats.
 * See docs/providers.md for the pinned descriptor and accounting evidence. */
export function antigravityAdapter(): ProviderAdapter {
  const requests = new Map<string, string>();
  let requestBytes = 0;
  return {
    id: "antigravity-db", provider: "antigravity",
    async discoverRoots({ home, options }) { return [options.antigravityRoot ?? join(home, ".gemini")]; },
    async *identify(root, onWarning) {
      const candidates: ProviderSession[] = [];
      // An override accepts one surface's data root; the default contains all three.
      const directories = [root, ...["antigravity", "antigravity-ide", "antigravity-cli"].map((surface) => join(root, surface))];
      for (const directory of directories) {
        let entries;
        try {
          if (!(await lstat(directory)).isDirectory() || !(await lstat(join(directory, "conversations"))).isDirectory()) continue;
          entries = await readdir(join(directory, "conversations"), { withFileTypes: true });
        }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; if (!onWarning) throw error; onWarning(antigravityWarnings.unreadable); continue; }
        for (const entry of entries) {
          if (!entry.isFile()) continue; // Never traverse source symlinks.
          if (entry.name.endsWith(".pb")) { onWarning?.(antigravityWarnings.legacy); continue; }
          if (!entry.name.endsWith(".db") || !uuid.test(entry.name.slice(0, -3))) continue;
          try { const data = projection(join(directory, "conversations", entry.name)); if (data) candidates.push(data.identity); }
          catch (error) { if (!onWarning) throw error; onWarning(antigravityWarnings.unreadable); }
        }
      }
      yield* candidates.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.path.localeCompare(b.path));
    },
    async analyze(identity, context) {
      const data = projection(identity.path);
      if (!data || data.identity.id !== identity.id) return null;
      if (data.identity.cwd !== identity.cwd) throw new Error("Antigravity ownership changed during analysis.");
      const session = emptySession(data.identity, "antigravity", context, { source: "antigravity-db", fidelity: "message", tokens: "unavailable", tools: "observed", turns: "observed", timing: "provider", usageUnit: "request" });
      const velocity = new VelocityAccumulator(), dimension = (model: string) => velocityDimension("antigravity", {}, "unknown", model, null);
      let partial = data.partial;
      const calls = new Set<string>();
      for (const step of data.steps) {
        observeTime(session, step.at);
        if (step.type === 14) session.metrics.userTurns++;
        if (step.type === 15) session.metrics.assistantMessages++;
        if (step.tool && !calls.has(step.tool.id)) {
          calls.add(step.tool.id); increment(session.tools, step.tool.name);
          velocity.tool(step.at, dimension("<unknown>"), 1, "session");
        }
      }
      const observations = data.generations.length ? data.generations : data.steps.filter((step) => step.usage).map((step) => ({ ...step, model: "<unknown>" }));
      // Unique joins are indexed once so missing timestamps do not turn a long
      // history into a quadratic scan of all steps for every generation.
      const byMessage = new Map<string, Step | null>(), byExecution = new Map<string, Step | null>();
      const insert = (map: Map<string, Step | null>, key: string | null, step: Step): void => {
        if (key) map.set(key, map.has(key) ? null : step);
      };
      for (const step of data.steps) { insert(byMessage, step.usage?.message ?? null, step); insert(byExecution, step.execution, step); }
      const executions = new Map<string, number>(), messages = new Map<string, number>();
      for (const row of observations) {
        if (row.execution) executions.set(row.execution, (executions.get(row.execution) ?? 0) + 1);
        if (row.usage?.message) messages.set(row.usage.message, (messages.get(row.usage.message) ?? 0) + 1);
      }
      for (const observation of observations) {
        const observed = observation.usage;
        if (!observed) continue;
        const model = observation.model === "<unknown>" ? observed.model : observation.model;
        let at = observation.at;
        if (!at && observed.message && messages.get(observed.message) === 1) {
          const step = byMessage.get(observed.message);
          if (step && (!observation.execution || step.execution === observation.execution)) at = step.at;
        }
        if (!at && observation.execution && !observed.message && executions.get(observation.execution) === 1) {
          at = byExecution.get(observation.execution)?.at ?? null;
        }
        const signature = JSON.stringify([at, model, observed.usage]);
        // Native response IDs survive copied/forked histories; equal counters alone are never a dedupe key.
        const key = observed.response ? `response:${observed.response}` : `${identity.id}:row:${observation.index}`;
        const previous = requests.get(key);
        if (previous !== undefined) { if (previous !== signature) partial = true; continue; }
        if (data.fork && !observed.response) { partial = true; continue; }
        if (requests.size >= 1_000_000 || requestBytes + key.length + signature.length > 64 * 1024 * 1024) { partial = true; continue; }
        if (observed.response && context.claimRequest && !context.claimRequest(session, observed.response)) continue;
        requests.set(key, signature);
        requestBytes += key.length + signature.length;
        session.evidence!.tokens = "reported";
        observeTime(session, at);
        addUsage(session, context, model, observed.usage, at, "request", 1, { velocity, dimension: dimension(model), coverage: { reasoning: observed.reasoning, cacheRead: true, cacheWrite: true } });
      }
      session.velocity = velocity.finish(identity.createdAt, dimension("<unknown>"), session.lastEventAt ?? session.updatedAt);
      session.transcript.warnings.push(antigravityWarnings.scope);
      if (partial || data.fork) { session.evidence!.accounting = "partial"; session.transcript.warnings.push(antigravityWarnings.partial); }
      finish(session);
      if (session.evidence!.accounting === "partial") session.costComplete = false;
      return session;
    },
  };
}
