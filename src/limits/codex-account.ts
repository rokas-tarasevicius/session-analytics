import { spawn } from "node:child_process";

import { codexPlans, type CodexAccountState, type CodexPlan, type LimitObservation } from "./types.ts";

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const finite = (value: unknown): number | null => {
  const number = typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
};

function meterName(limitId: string, minutes: number | null): string {
  const base = minutes === 300 ? "five_hour" : minutes === 10_080 ? "seven_day" : minutes ? `window_${minutes}m` : "window";
  const id = limitId.toLowerCase();
  return id !== "codex" && /^[a-z0-9_-]{1,40}$/.test(id) ? `${id}.${base}` : base;
}

/**
 * Project an `account/rateLimits/read` response into meters, credit balance and banked reset credits.
 * Opaque credit IDs, backend titles, the account ID and upsell banners are dropped here.
 */
export function codexAccountState(value: unknown, observedAt: number): CodexAccountState | null {
  const response = record(value);
  if (!response) return null;
  const buckets = record(response["rateLimitsByLimitId"]) ?? { codex: response["rateLimits"] };
  const observations: LimitObservation[] = [];
  let plan: CodexPlan | null = null, balance: CodexAccountState["credits"] = null;
  for (const [limitId, snapshot] of Object.entries(buckets)) {
    const limits = record(snapshot);
    if (!limits) continue;
    for (const slot of ["primary", "secondary"]) {
      const window = record(limits[slot]);
      const used = finite(window?.["usedPercent"]), resetsAt = finite(window?.["resetsAt"]), minutes = finite(window?.["windowDurationMins"]);
      if (used === null || resetsAt === null) continue;
      observations.push({
        provider: "codex", meter: meterName(limitId, minutes), windowMinutes: minutes !== null && minutes > 0 ? Math.round(minutes) : null,
        resetsAt, observedAt, usedPercent: used, status: used >= 100 ? "rejected" : "allowed", source: "codex-account",
      });
    }
    if (typeof limits["planType"] === "string" && (codexPlans as readonly string[]).includes(limits["planType"])) plan = limits["planType"] as CodexPlan;
    const credits = record(limits["credits"]);
    if (credits && limitId === "codex") balance = { hasCredits: credits["hasCredits"] === true, unlimited: credits["unlimited"] === true, balance: finite(credits["balance"]) };
  }
  const summary = record(response["rateLimitResetCredits"]);
  const available = finite(summary?.["availableCount"]);
  const details = Array.isArray(summary?.["credits"]) ? summary["credits"] as unknown[] : null;
  return {
    observedAt, plan, observations, credits: balance,
    ordinaryUsageAllowed: typeof response["ordinaryUsageAllowed"] === "boolean" ? response["ordinaryUsageAllowed"] : null,
    resetCredits: available === null ? null : {
      available: Math.max(0, Math.min(1000, Math.floor(available))),
      credits: details === null ? null : details.slice(0, 50).map(record).filter((credit): credit is Record<string, unknown> => credit !== null).map((credit) => ({
        status: credit["status"] === "available" || credit["status"] === "redeeming" || credit["status"] === "redeemed" ? credit["status"] : "unknown",
        scope: credit["resetType"] === "codexRateLimits" ? "all" : "unknown",
        grantedAt: finite(credit["grantedAt"]),
        expiresAt: finite(credit["expiresAt"]),
      })),
    },
  };
}

/**
 * Ask the local Codex app-server for the account's limits and banked reset credits, the same read Codex's own
 * usage display makes. Codex contacts OpenAI with its own login; this process never sees a token. Only
 * `initialize` and `account/rateLimits/read` are sent: reset credits are never redeemed here.
 */
export async function readCodexAccount(environment: NodeJS.ProcessEnv = process.env, now = Date.now() / 1000, timeoutMs = 20_000): Promise<CodexAccountState | null> {
  const binary = environment["SESSION_ANALYTICS_CODEX_BIN"] || "codex";
  return await new Promise((resolve) => {
    let settled = false, buffer = "";
    const child = spawn(binary, ["app-server"], { stdio: ["pipe", "pipe", "ignore"], env: environment });
    const finish = (value: CodexAccountState | null) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      child.stdout.removeAllListeners(); child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const send = (message: unknown) => { try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch { finish(null); } };
    child.on("error", () => finish(null));
    child.on("exit", () => finish(null));
    child.stdin.on("error", () => finish(null));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 4 * 1024 * 1024) { finish(null); return; }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message: Record<string, unknown> | null = null;
        try { message = record(JSON.parse(line)); } catch { continue; }
        if (message?.["id"] === 1) {
          if (message["error"]) { finish(null); return; }
          send({ method: "initialized" });
          send({ id: 2, method: "account/rateLimits/read", params: { excludeResetCreditDetails: false } });
        } else if (message?.["id"] === 2) {
          finish(message["error"] ? null : codexAccountState(message["result"], Math.floor(now)));
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "session-analytics", version: "1" } } });
  });
}
