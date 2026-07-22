import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { analyzeMachineSessionsIsolated } from "./analysis-process.ts";
import type { AnalyzeOptions, MachineAnalytics } from "./types.ts";

const toolRoot = fileURLToPath(new URL(".", import.meta.url));
const publicRoot = join(toolRoot, "public");

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const valueFlags = new Set([
  "--claude-root",
  "--codex-archive-root",
  "--codex-root",
  "--cursor-database",
  "--database",
  "--port",
  "--rate-card",
  "--repo-id",
  "--repo-name",
  "--repo-remote",
  "--repo-root",
]);
const booleanFlags = new Set(["--exclude-hidden", "--help", "--include-hidden", "--open", "--version"]);
for (let index = 2; index < process.argv.length; index += 1) {
  const flag = process.argv[index];
  if (!flag?.startsWith("--") || (!valueFlags.has(flag) && !booleanFlags.has(flag))) {
    process.stderr.write(`Unknown session analytics server argument: ${flag ?? "<missing>"}\n`);
    process.exit(2);
  }
  if (valueFlags.has(flag)) {
    const value = process.argv[index + 1];
    if (!value || value.startsWith("--")) {
      process.stderr.write(`Session analytics server argument ${flag} requires a value.\n`);
      process.exit(2);
    }
    index += 1;
  }
}
if (process.argv.includes("--help")) {
  process.stdout.write(`Machine Session Analytics server 0.3.1

Usage: node scripts/server.ts [--open] [--port PORT] [analysis options]
The server always binds to 127.0.0.1 and accepts read-only GET requests.
With --open, this one command performs the complete scan and opens the dashboard.
If a compatible dashboard already uses the port, the command reuses it.
`);
  process.exit(0);
}
if (process.argv.includes("--version")) {
  process.stdout.write("0.3.1\n");
  process.exit(0);
}

function headers(contentType: string, cacheControl = "no-store"): Record<string, string> {
  return {
    "Cache-Control": cacheControl,
    "Content-Security-Policy":
      "default-src 'self'; connect-src 'self'; font-src 'self'; img-src 'self'; object-src 'none'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "Content-Type": contentType,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, headers("application/json; charset=utf-8"));
  response.end(`${JSON.stringify(value)}\n`);
}

async function sendFile(response: ServerResponse, path: string): Promise<void> {
  const contentTypes: Record<string, string> = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml; charset=utf-8",
    ".woff2": "font/woff2",
  };
  const content = await readFile(path);
  const cacheControl = extname(path) === ".woff2" ? "public, max-age=300" : "no-store";
  response.writeHead(
    200,
    headers(contentTypes[extname(path)] ?? "application/octet-stream", cacheControl),
  );
  response.end(content);
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("rate card")) return "The configured rate card is invalid or unavailable.";
  if (message.includes("repository")) return "The requested repository could not be selected.";
  return "Local analytics evidence is unavailable or could not be parsed.";
}

function loopbackRequest(request: { headers: Record<string, string | string[] | undefined> }): boolean {
  const host = request.headers.host ?? "";
  const hostValue = Array.isArray(host) ? host[0] ?? "" : host;
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(hostValue)) return false;
  const origin = request.headers.origin;
  if (!origin || Array.isArray(origin)) return !Array.isArray(origin);
  try {
    const hostname = new URL(origin).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost";
  } catch {
    return false;
  }
}

const staticFiles = new Map<string, string>([
  ["/", join(publicRoot, "index.html")],
  ["/app.js", join(publicRoot, "app.js")],
  ["/styles.css", join(publicRoot, "styles.css")],
  ["/fonts/space-grotesk-latin.woff2", join(publicRoot, "fonts", "space-grotesk-latin.woff2")],
  ["/fonts/geist-mono-latin.woff2", join(publicRoot, "fonts", "geist-mono-latin.woff2")],
  ["/brands/codex.svg", join(publicRoot, "brands", "codex.svg")],
  ["/brands/claude.svg", join(publicRoot, "brands", "claude.svg")],
  ["/brands/cursor.svg", join(publicRoot, "brands", "cursor.svg")],
]);

const repositoryName = argument("--repo-name") ?? process.env["MACHINE_SESSION_REPO_NAME"] ?? process.env["CONDUCTOR_SESSION_REPO_NAME"];
const repositoryId = argument("--repo-id") ?? process.env["MACHINE_SESSION_REPO_ID"] ?? process.env["CONDUCTOR_SESSION_REPO_ID"];
const repositoryRemote =
  argument("--repo-remote") ?? process.env["MACHINE_SESSION_REPO_REMOTE"] ?? process.env["CONDUCTOR_SESSION_REPO_REMOTE"];
const databasePath = argument("--database") ?? process.env["MACHINE_SESSION_METADATA_DATABASE"] ?? process.env["CONDUCTOR_ANALYTICS_DATABASE"];
const codexRoot = argument("--codex-root") ?? process.env["MACHINE_CODEX_SESSIONS_ROOT"] ?? process.env["CONDUCTOR_CODEX_SESSIONS_ROOT"];
const codexArchiveRoot =
  argument("--codex-archive-root") ?? process.env["MACHINE_CODEX_ARCHIVED_SESSIONS_ROOT"] ?? process.env["CONDUCTOR_CODEX_ARCHIVED_SESSIONS_ROOT"];
const claudeRoot = argument("--claude-root") ?? process.env["MACHINE_CLAUDE_PROJECTS_ROOT"] ?? process.env["CONDUCTOR_CLAUDE_PROJECTS_ROOT"];
const cursorDatabasePath = argument("--cursor-database") ?? process.env["MACHINE_CURSOR_DATABASE"] ?? process.env["CONDUCTOR_CURSOR_DATABASE"];
const rateCardPath = argument("--rate-card") ?? process.env["MACHINE_SESSION_RATE_CARD"] ?? process.env["CONDUCTOR_SESSION_RATE_CARD"];

const analyzeOptions: AnalyzeOptions = {
  includeHidden: !process.argv.includes("--exclude-hidden"),
  ...(argument("--repo-root") || process.env["MACHINE_SESSION_REPO_ROOT"] || process.env["CONDUCTOR_SESSION_REPO_ROOT"]
    ? { repositoryRoot: argument("--repo-root") ?? process.env["MACHINE_SESSION_REPO_ROOT"] ?? process.env["CONDUCTOR_SESSION_REPO_ROOT"] }
    : {}),
  ...(repositoryName ? { repositoryName } : {}),
  ...(repositoryId ? { repositoryId } : {}),
  ...(repositoryRemote ? { repositoryRemote } : {}),
  ...(databasePath ? { databasePath } : {}),
  ...(codexRoot ? { codexRoot } : {}),
  ...(codexArchiveRoot ? { codexArchiveRoot } : {}),
  ...(claudeRoot ? { claudeRoot } : {}),
  ...(cursorDatabasePath ? { cursorDatabasePath } : {}),
  ...(rateCardPath ? { rateCardPath } : {}),
};

let analyticsPromise: Promise<MachineAnalytics> | null = null;
let analyticsPending = false;
let snapshotReady = false;
function analytics(refresh = false): Promise<MachineAnalytics> {
  if (analyticsPending && analyticsPromise) return analyticsPromise;
  if (refresh || !analyticsPromise) {
    analyticsPending = true;
    analyticsPromise = analyzeMachineSessionsIsolated(analyzeOptions)
      .then((result) => {
        snapshotReady = true;
        return result;
      })
      .finally(() => {
        analyticsPending = false;
      });
  }
  return analyticsPromise;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  try {
    if (!loopbackRequest(request)) {
      sendJson(response, 403, { error: "Session analytics accepts loopback requests only." });
      return;
    }
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Session analytics is read-only." });
      return;
    }
    if (url.pathname === "/api/health") {
      sendJson(response, 200, {
        service: "machine-session-analytics",
        snapshot: snapshotReady ? "ready" : analyticsPending ? "building" : "not-started",
        status: "ok",
      });
      return;
    }
    if (url.pathname === "/api/analytics") {
      sendJson(response, 200, await analytics(url.searchParams.get("refresh") === "1"));
      return;
    }
    const path = staticFiles.get(url.pathname);
    if (path) {
      await sendFile(response, path);
      return;
    }
    sendJson(response, 404, { error: "Not found." });
  } catch (error) {
    if (url.pathname === "/api/analytics") analyticsPromise = null;
    sendJson(response, 502, { error: safeError(error) });
  }
});

const conductorPort = process.env["CONDUCTOR_PORT"];
const companionPort = conductorPort ? String(Number(conductorPort) + 4) : null;
const requestedPort =
  argument("--port") ??
  process.env["MACHINE_SESSION_ANALYTICS_PORT"] ??
  process.env["CONDUCTOR_SESSION_ANALYTICS_PORT"] ??
  companionPort ??
  "4174";
const port = Number(requestedPort);
if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
  throw new Error(
    `Session analytics port must be an integer from 1024 through 65535; received ${requestedPort}.`,
  );
}

const dashboardUrl = `http://127.0.0.1:${port}`;

async function openDashboard(): Promise<void> {
  await new Promise<void>((resolve) => {
    execFile("open", [dashboardUrl], (error) => {
      if (error) process.stderr.write(`Could not open the browser: ${error.message}\n`);
      resolve();
    });
  });
}

async function compatibleDashboardIsRunning(): Promise<boolean> {
  try {
    const response = await fetch(`${dashboardUrl}/api/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return false;
    const body = await response.json() as { service?: unknown; status?: unknown };
    return body.service === "machine-session-analytics" && body.status === "ok";
  } catch {
    return false;
  }
}

server.on("error", (error: NodeJS.ErrnoException) => {
  void (async () => {
    if (error.code === "EADDRINUSE" && await compatibleDashboardIsRunning()) {
      process.stdout.write(`Machine session analytics already running: ${dashboardUrl}\n`);
      if (process.argv.includes("--open")) await openDashboard();
      process.exit(0);
    }
    if (error.code === "EADDRINUSE") {
      process.stderr.write(`Port ${port} is already in use by another local service.\n`);
    } else {
      process.stderr.write(`Machine session analytics could not start: ${safeError(error)}\n`);
    }
    process.exit(1);
  })();
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Machine session analytics ready: ${dashboardUrl}\n`);
  process.stdout.write("Read-only local analysis; transcript message and reasoning content is not returned.\n");
  const warmup = analytics(false);
  void warmup
    .then((result) => {
      process.stdout.write(
        `Analyzed ${result.summary.analyzedSessions}/${result.summary.sessions} sessions across ` +
          `${result.summary.repositories} repositories; ` +
          `priced usage value $${result.summary.estimatedSpendUsd.toFixed(2)} (not an invoice).\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`Session analytics warmup failed: ${safeError(error)}\n`);
    });
  if (process.argv.includes("--open")) {
    void warmup.then(openDashboard, openDashboard);
  }
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
