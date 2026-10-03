import { InteropError } from "./error.ts";
import { serviceId } from "../brand.ts";
import { version } from "../version.ts";
import type { MachineAnalytics } from "../types.ts";
const maximumOtlpBytes = 64 * 1024 * 1024;

export const semanticConventionsVersion = "1.37.0";
export const semanticConventionsCommit = "aec6e9d3e86754683dab7c707655d69d953b2768";
type Attribute = { key: string; value: { stringValue: string } | { intValue: string } | { doubleValue: number } };
const string = (key: string, value: string): Attribute => ({ key, value: { stringValue: value } });
const integer = (key: string, value: number): Attribute => {
  if (!Number.isSafeInteger(value) || value < 0) throw new InteropError("OTLP counters must be safe non-negative integers.");
  return { key, value: { intValue: String(value) } };
};
const double = (key: string, value: number): Attribute => ({ key, value: { doubleValue: value } });

/** These are explicitly session aggregates, not reconstructed inference calls. */
export function otlpLogs(snapshot: MachineAnalytics): object {
  const timestamp = Date.parse(snapshot.generatedAt);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new InteropError("OTLP snapshot timestamp is invalid.");
  const timeUnixNano = (BigInt(timestamp) * 1_000_000n).toString();
  if (BigInt(timeUnixNano) > 18_446_744_073_709_551_615n) throw new InteropError("OTLP snapshot timestamp is out of range.");
  return { resourceLogs: [{
    resource: { attributes: [string("service.name", serviceId), integer("session_analytics.schema.version", 1)] },
    scopeLogs: [{
      scope: { name: `${serviceId}.export`, version, attributes: [string("session_analytics.semconv.version", semanticConventionsVersion), string("session_analytics.semconv.commit", semanticConventionsCommit)] },
      schemaUrl: `https://opentelemetry.io/schemas/${semanticConventionsVersion}`,
      logRecords: snapshot.sessions.map((session) => {
        const attributes = [
          string("session_analytics.record.type", "session_aggregate"),
          string("session_analytics.provider", session.provider),
          string("session_analytics.repository.key", session.repositoryId),
          string("session_analytics.session.key", session.sessionKey),
          string("session_analytics.cost.basis", session.costBasis),
          string("session_analytics.transcript.status", session.transcript.status),
          integer("gen_ai.usage.input_tokens", session.tokens.inputTokens),
          integer("gen_ai.usage.output_tokens", session.tokens.outputTokens),
          integer("session_analytics.usage.cache_read_tokens", session.tokens.cachedInputTokens),
          integer("session_analytics.usage.cache_write_tokens", session.tokens.cacheWriteInputTokens),
          integer("session_analytics.usage.reasoning_tokens", session.tokens.reasoningOutputTokens),
          integer("session_analytics.tool.calls", session.metrics.toolCalls),
          integer("session_analytics.model.calls", session.metrics.modelCalls),
          double("session_analytics.usage.value_usd", session.cost.totalUsd),
          double("session_analytics.usage.upper_value_usd", session.cost.upperEstimateUsd),
        ];
        if (session.pricedTokenCoverage !== null) attributes.push(double("session_analytics.pricing.coverage", session.pricedTokenCoverage));
        const model = session.models.length === 1 ? session.models[0] : null;
        if (model && model.model && model.model !== "<unknown>" && model.inputTokens === session.tokens.inputTokens && model.outputTokens === session.tokens.outputTokens) attributes.push(string("gen_ai.response.model", model.model));
        return { timeUnixNano, observedTimeUnixNano: timeUnixNano, body: { stringValue: "Observed session usage aggregate" }, attributes };
      }),
    }],
  }] };
}

export function otlpEndpoint(value: string): URL {
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && local))) throw new InteropError();
    return url;
  } catch { throw new InteropError("OTLP requires an HTTPS URL (HTTP is allowed on loopback), without userinfo or a fragment."); }
}

/** Called only with the explicit CLI flag. No environment activation, redirects, or retries. */
export async function postOtlp(endpoint: URL, body: string): Promise<void> {
  const target = otlpEndpoint(endpoint.href);
  if (Buffer.byteLength(body) > maximumOtlpBytes) throw new InteropError("OTLP payload exceeds the 64 MiB limit; the local export is retained.");
  try {
    const response = await fetch(target, {
      method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body, redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 200 || !/^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? "")) { await response.body?.cancel(); throw new InteropError(); }
    const reader = response.body?.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 64 * 1024) { await reader.cancel(); throw new InteropError(); }
        parts.push(chunk.value);
      }
    }
    const result = JSON.parse(Buffer.concat(parts).toString("utf8")) as { partialSuccess?: { rejectedLogRecords?: string | number; errorMessage?: string } };
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new InteropError();
    const partial = result.partialSuccess;
    if (partial !== undefined && partial !== null) {
      if (typeof partial !== "object" || Array.isArray(partial)) throw new InteropError();
      const rejected = partial.rejectedLogRecords ?? 0;
      if ((rejected !== 0 && rejected !== "0") || (partial.errorMessage ?? "") !== "") throw new InteropError();
    }
  } catch { throw new InteropError("OTLP delivery was not fully acknowledged. The local export is retained; delivery may have occurred. No automatic retry was made."); }
}
