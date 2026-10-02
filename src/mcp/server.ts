import type { Readable, Writable } from "node:stream";
import { brand, serviceId } from "../brand.ts";
import { version } from "../version.ts";
import type { AnalyzeOptions } from "../types.ts";
import { SnapshotCache } from "./cache.ts";
import { buildPayload, ScopeError, summarize } from "./metrics.ts";
import { record } from "./names.ts";
import { loadSnapshot } from "./snapshot.ts";
import { InputError, toolDefinitions, toolName, validateArguments } from "./tools.ts";
import type { McpSnapshot } from "./types.ts";

export const PROTOCOL_VERSION = "2026-07-28";
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18"] as const;
export const MAX_MESSAGE_BYTES = 65_536;
const MAX_PENDING = 16;
const SERVER_INFO = { name: serviceId, title: brand.name, version };
const CAPABILITIES = { tools: { listChanged: false } };
const INSTRUCTIONS = "Read-only local metrics. Tools default to the launch repository when known. Paths and transcript content are never tool inputs or outputs. API-equivalent value is not an invoice; inspect coverage, sample sizes, UTC windows and snapshot age.";
const VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";
type Id = string | number;
const isId = (id: unknown): id is Id => (typeof id === "string" && id.length <= 256) || (typeof id === "number" && Number.isSafeInteger(id));
const only = (value: Record<string, unknown>, keys: string[]): boolean => Object.keys(value).every((key) => keys.includes(key));

export interface McpServerOptions {
  analysis: AnalyzeOptions;
  ttlSeconds: number;
  input?: Readable;
  output?: Writable;
  load?: (signal: AbortSignal) => Promise<McpSnapshot>;
  now?: () => number;
}

/** Newline-delimited stdio only. This entry point never opens a listener or requests client roots. */
export function serveMcp(options: McpServerOptions): { close: () => void; closed: Promise<void> } {
  const input = options.input ?? process.stdin, output = options.output ?? process.stdout;
  const now = options.now ?? Date.now;
  const controller = new AbortController();
  const cache = new SnapshotCache(() => options.load ? options.load(controller.signal) : loadSnapshot(options.analysis, controller.signal), options.ttlSeconds * 1000, now);
  const pending = new Map<Id, { cancelled: boolean }>();
  let legacy: "new" | "negotiated" | "ready" = "new";
  let stopped = false, buffer = Buffer.alloc(0), discarding = false;
  let resolveClosed: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const close = (): void => {
    if (stopped) return;
    stopped = true;
    for (const request of pending.values()) request.cancelled = true;
    controller.abort();
    input.off("data", onData); input.off("end", close); input.off("error", close); input.pause();
    input.destroy();
    buffer = Buffer.alloc(0);
    resolveClosed();
  };
  const send = (message: object): void => {
    if (stopped) return;
    const serialized = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(serialized) + output.writableLength > 4 * 1024 * 1024) { close(); return; }
    output.write(serialized);
  };
  const error = (id: Id | null, code: number, message: string, data?: object): void => {
    send({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
  };
  const success = (id: Id, result: object, modern: boolean): void => {
    send({ jsonrpc: "2.0", id, result: modern ? { ...result, resultType: "complete", _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO } } : result });
  };
  const toolError = (id: Id, message: string, modern: boolean): void => {
    success(id, { isError: true, content: [{ type: "text", text: message }] }, modern);
  };

  const handle = async (raw: unknown): Promise<void> => {
    const message = record(raw);
    if (!message || message["jsonrpc"] !== "2.0" || typeof message["method"] !== "string" ||
        !only(message, ["jsonrpc", "id", "method", "params"]) ||
        (Object.hasOwn(message, "id") && !isId(message["id"]))) {
      error(null, -32600, "Invalid request."); return;
    }
    const method = message["method"], id = message["id"];
    const params = message["params"] === undefined ? {} : record(message["params"]);
    // Notifications never receive a response and cannot execute a tool or scan.
    if (id === undefined) {
      if (!params) return;
      if (method === "notifications/initialized" && legacy === "negotiated") legacy = "ready";
      if (method === "notifications/cancelled" && isId(params["requestId"])) {
        const request = pending.get(params["requestId"]);
        if (request) request.cancelled = true;
      }
      return;
    }
    if (!isId(id)) return;
    if (!params || (params["_meta"] !== undefined && !record(params["_meta"]))) { error(id, -32602, "Invalid parameters."); return; }
    const meta = record(params["_meta"]);
    const requested = meta?.[VERSION_KEY];
    const modern = requested !== undefined;
    if (modern) {
      if (typeof requested !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(requested)) { error(id, -32602, "Invalid protocol metadata."); return; }
      if (requested !== PROTOCOL_VERSION) {
        error(id, -32022, "Unsupported protocol version", { supported: [PROTOCOL_VERSION, ...LEGACY_VERSIONS], requested }); return;
      }
      if (!record(meta?.[CAPABILITIES_KEY])) { error(id, -32602, "Missing client capabilities."); return; }
    }
    if (method === "initialize" && !modern) {
      if (legacy !== "new") { error(id, -32600, "Already initialized."); return; }
      const client = record(params["clientInfo"]);
      if (!only(params, ["protocolVersion", "capabilities", "clientInfo", "_meta"]) || typeof params["protocolVersion"] !== "string" ||
          !record(params["capabilities"]) || !client || typeof client["name"] !== "string" || typeof client["version"] !== "string") {
        error(id, -32602, "Invalid initialization parameters."); return;
      }
      const requestedLegacy = params["protocolVersion"];
      const protocolVersion = LEGACY_VERSIONS.find((item) => item === requestedLegacy) ?? LEGACY_VERSIONS[0];
      legacy = "negotiated";
      success(id, { protocolVersion, capabilities: CAPABILITIES, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS }, false); return;
    }
    if (method === "ping") {
      if (!only(params, ["_meta"])) { error(id, -32602, "Invalid ping parameters."); return; }
      success(id, {}, modern); return;
    }
    if (!modern && legacy !== "ready") { error(id, -32600, "Initialize first or supply modern protocol metadata."); return; }
    if (method === "server/discover" && modern) {
      if (!only(params, ["_meta"])) { error(id, -32602, "Invalid discovery parameters."); return; }
      success(id, { supportedVersions: [PROTOCOL_VERSION, ...LEGACY_VERSIONS], capabilities: CAPABILITIES, instructions: INSTRUCTIONS, ttlMs: 3_600_000, cacheScope: "public" }, true); return;
    }
    if (method === "tools/list") {
      if (!only(params, ["_meta"])) { error(id, -32602, "Invalid tools/list parameters; the complete catalog fits in one page."); return; }
      success(id, { tools: toolDefinitions, ...(modern ? { ttlMs: 3_600_000, cacheScope: "public" } : {}) }, modern); return;
    }
    if (method !== "tools/call") { error(id, -32601, "Method not found."); return; }
    if (!only(params, ["name", "arguments", "_meta"])) { error(id, -32602, "Invalid tools/call parameters."); return; }
    const name = toolName(params["name"]);
    if (!name) { error(id, -32602, "Unknown tool."); return; }
    if (pending.has(id)) { error(null, -32600, "Duplicate in-flight request ID."); return; }
    if (pending.size >= MAX_PENDING) { error(id, -32000, "Too many pending requests. Retry after a response."); return; }
    let args;
    try { args = validateArguments(name, params["arguments"]); }
    catch { toolError(id, new InputError().message, modern); return; }
    const request = { cancelled: false };
    pending.set(id, request);
    try {
      const { value } = await cache.get();
      if (request.cancelled || stopped) return;
      const payload = buildPayload(value, name, args, now(), options.ttlSeconds);
      success(id, { content: [{ type: "text", text: summarize(payload) }, { type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: false }, modern);
    } catch (failure) {
      if (!request.cancelled && !stopped) toolError(id, failure instanceof ScopeError ? failure.message : "Local metrics are unavailable. Check configured evidence sources and retry; no local error details are exposed.", modern);
    } finally { pending.delete(id); }
  };

  const onData = (chunk: Buffer | string): void => {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    let offset = 0;
    while (offset < bytes.length && !stopped) {
      const newline = bytes.indexOf(10, offset);
      const end = newline < 0 ? bytes.length : newline;
      if (!discarding) {
        if (buffer.length + end - offset > MAX_MESSAGE_BYTES) {
          buffer = Buffer.alloc(0); discarding = true; error(null, -32600, "Request exceeds the size limit.");
        } else buffer = Buffer.concat([buffer, bytes.subarray(offset, end)]);
      }
      if (newline < 0) break;
      if (!discarding) {
        let message: unknown;
        try { message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)); }
        catch { error(null, -32700, "Parse error."); }
        if (message !== undefined) void handle(message).catch(() => error(null, -32603, "Internal error."));
      }
      buffer = Buffer.alloc(0); discarding = false; offset = newline + 1;
    }
  };
  input.on("data", onData); input.once("end", close); input.once("error", close);
  output.on("error", close);
  return { close, closed };
}
