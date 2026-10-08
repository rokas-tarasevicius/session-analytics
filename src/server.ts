import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AnalysisHeapLimitError, analyzeMachineSessionsIsolated } from "./analysis-process.ts";
import { analysisBooleanFlags, analysisValueFlags, analyzeOptionsFrom, pricingHelp, setting, argument } from "./options.ts";
import { refreshPricingIfStale } from "./pricing/update.ts";
import type { MachineAnalytics, SharedSnapshot } from "./types.ts";
import { loadSnapshot } from "./interop/snapshot.ts";
import { assertSnapshotOptions } from "./interop/cli.ts";
import { brand, serviceId } from "./brand.ts";
import { version } from "./version.ts";
import { indexErrorCode, indexErrorMessage } from "./store/errors.ts";

const toolRoot = fileURLToPath(new URL(".", import.meta.url));
const publicRoot = join(toolRoot, "public");

const valueFlags = new Set([...analysisValueFlags, "--port", "--snapshot"]);
const booleanFlags = new Set([...analysisBooleanFlags, "--exclude-hidden", "--help", "--include-hidden", "--no-open", "--open", "--version", "--no-additional-providers", "--offline"]);
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
  process.stdout.write(`${brand.name} dashboard ${version}

Usage: ${brand.command} [dashboard] [--no-open] [--port PORT] [analysis options]
The server always binds to 127.0.0.1 and accepts read-only GET requests.
With --open, this one command performs the complete scan and opens the dashboard.
If a compatible dashboard already uses the port, the command reuses it.
${pricingHelp}
--snapshot FILE loads a versioned full or shared snapshot; refresh re-reads that file and never scans local stores.
Use --no-index for a full scan, or --data-dir PATH to choose the private index directory.
`);
  process.exit(0);
}
if (process.argv.includes("--version")) {
  process.stdout.write(`${version}\n`);
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
  const indexError = indexErrorMessage(indexErrorCode(error));
  if (indexError) return indexError;
  if (error instanceof AnalysisHeapLimitError) return error.message;
  const message = error instanceof Error ? error.message : "";
  if (message.includes("Snapshot")) return "The snapshot file is invalid, unsupported, or unavailable.";
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
  ["/history-coverage.js", join(publicRoot, "history-coverage.js")],
  ["/", join(publicRoot, "index.html")],
  ["/app.js", join(publicRoot, "app.js")],
  ["/view-model.js", join(publicRoot, "view-model.js")],
  ["/ui.js", join(publicRoot, "ui.js")],

  ["/providers.js", join(publicRoot, "providers.js")],
  ["/chart-colors.js", join(publicRoot, "chart-colors.js")],
  ["/chart-legend.js", join(publicRoot, "chart-legend.js")],
  ["/chart-scale.js", join(publicRoot, "chart-scale.js")],

  ["/velocity.js", join(publicRoot, "velocity.js")],
  ["/velocity-data.js", join(publicRoot, "velocity-data.js")],
  ["/velocity.css", join(publicRoot, "velocity.css")],

  ["/tools.js", join(publicRoot, "tools.js")],
  ["/tools-data.js", join(publicRoot, "tools-data.js")],
  ["/tools.css", join(publicRoot, "tools.css")],

  ["/styles.css", join(publicRoot, "styles.css")],
  ["/fonts/geist-latin.woff2", join(publicRoot, "fonts", "geist-latin.woff2")],

  ["/pricing.js", join(publicRoot, "pricing.js")],
  ["/pricing-data.js", join(publicRoot, "pricing-data.js")],
  ["/model-id.js", join(publicRoot, "model-id.js")],
  ["/pricing.css", join(publicRoot, "pricing.css")],
  ["/export-data.js", join(publicRoot, "export-data.js")],
  ["/evidence.js", join(publicRoot, "evidence.js")],
  ["/timestamps.js", join(publicRoot, "timestamps.js")],
  ["/export-menu.js", join(publicRoot, "export-menu.js")],
  ["/shared-view.js", join(publicRoot, "shared-view.js")],
  ["/interop.css", join(publicRoot, "interop.css")],
  ["/fonts/geist-mono-latin.woff2", join(publicRoot, "fonts", "geist-mono-latin.woff2")],
  ["/brands/codex.svg", join(publicRoot, "brands", "codex.svg")],
  ["/brands/claude.svg", join(publicRoot, "brands", "claude.svg")],
  ["/brands/cursor.svg", join(publicRoot, "brands", "cursor.svg")],
  ["/favicon.svg", join(publicRoot, "favicon.svg")],
]);

let analyzeOptions: import("./types.ts").AnalyzeOptions;
try { analyzeOptions = analyzeOptionsFrom(process.argv, process.env); }
catch { process.stderr.write("Invalid pricing configuration.\n"); process.exit(2); }
try { assertSnapshotOptions(process.argv); } catch {
  process.stderr.write("Snapshot input cannot be combined with analysis flags.\n");
  process.exit(2);
}
const snapshotFile = argument(process.argv, "--snapshot");

let analyticsPromise: Promise<MachineAnalytics | SharedSnapshot> | null = null;
let analyticsPending = false;
let snapshotReady = false;
function analytics(refresh = false): Promise<MachineAnalytics | SharedSnapshot> {
  if (analyticsPending && analyticsPromise) return analyticsPromise;
  if (refresh || !analyticsPromise) {
    analyticsPending = true;
    analyticsPromise = (snapshotFile ? loadSnapshot(snapshotFile) : analyzeMachineSessionsIsolated(analyzeOptions))
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
        service: serviceId,
        dataSource: snapshotFile ? "snapshot" : "live",
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
  setting(process.argv, process.env, "--port", "PORT") ??
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
    const [opener, ...openerArguments] =
      process.platform === "darwin"
        ? ["open"]
        : process.platform === "win32"
          ? ["cmd", "/c", "start", ""]
          : ["xdg-open"];
    execFile(opener ?? "open", [...openerArguments, dashboardUrl], (error) => {
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
    const body = await response.json() as { service?: unknown; status?: unknown; dataSource?: unknown };
    return body.service === serviceId && body.status === "ok" && body.dataSource === "live";
  } catch {
    return false;
  }
}

server.on("error", (error: NodeJS.ErrnoException) => {
  void (async () => {
    if (error.code === "EADDRINUSE" && !snapshotFile && await compatibleDashboardIsRunning()) {
      process.stdout.write(`${brand.name} already running: ${dashboardUrl}\n`);
      if (process.argv.includes("--open")) await openDashboard();
      process.exit(0);
    }
    if (error.code === "EADDRINUSE") {
      process.stderr.write(`Port ${port} is already in use by another local service.\n`);
    } else {
      process.stderr.write(`${brand.name} could not start: ${safeError(error)}\n`);
    }
    process.exit(1);
  })();
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`${brand.name} ready: ${dashboardUrl}\n`);
  process.stdout.write("Read-only local analysis; transcript message and reasoning content is not returned.\n");
  const warmup = analytics(false);
  void warmup
    .then((result) => {
      if ("kind" in result) {
        process.stdout.write(`Loaded shared aggregates for ${result.summary.sessions} sessions across ${result.repositories.length} repositories.\n`);
        return;
      }
      process.stdout.write(
        `Analyzed ${result.summary.analyzedSessions}/${result.summary.sessions} sessions across ` +
          `${result.summary.repositories} repositories; ` +
        `priced usage value $${result.summary.estimatedSpendUsd.toFixed(2)} (not an invoice).\n`,
      );
      // Startup-only refresh, after the first local scan. No analysis/API request waits on pricing I/O.
      if (!snapshotFile) void refreshPricingIfStale(analyzeOptions).then((update) => {
        if (update) process.stdout.write(`Background pricing update: ${update.status}. Refresh the dashboard snapshot to use new prices.\n`);
      }).catch(() => process.stderr.write("Background pricing update unavailable; cached rates remain in use.\n"));
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
