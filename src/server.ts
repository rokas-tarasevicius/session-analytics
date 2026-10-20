import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AnalysisHeapLimitError, analyzeMachineSessionsIsolated, noticeFullParse } from "./analysis-process.ts";
import { analysisBooleanFlags, analysisValueFlags, analyzeOptionsFrom, assertRemoteAnalysis, machineHelp, optionErrorMessage, pricingHelp, remoteBooleanFlags, remoteHelp, remoteValueFlags, setting, sourceHelp, argument, type RemoteOptions } from "./options.ts";
import { machinesPath, remoteFor } from "./machines/config.ts";
import { stopOnSignals } from "./processes.ts";
import { analyzeMachines, machineOptions, machineReads, type MachineReads } from "./remote.ts";
import { createDashboardPricing } from "./pricing/dashboard.ts";
import { pricingConfiguration } from "./pricing/catalog.ts";
import type { AnalysisHooks } from "./analyzer.ts";
import type { PendingAnalytics, ScanProgress, DashboardHealth, MachineAnalytics, MachineStatus, SharedSnapshot } from "./types.ts";
import { loadSnapshot } from "./interop/snapshot.ts";
import { assertSnapshotOptions } from "./interop/cli.ts";
import { brand, serviceId } from "./brand.ts";
import { version } from "./version.ts";
import { indexErrorCode, indexErrorMessage } from "./store/errors.ts";
import { dataDirectory } from "./store/database.ts";
import { readDashboardToken, writeDashboardToken } from "./store/dashboard.ts";
import { reuseRefusal } from "./dashboard-reuse.ts";
import { collectLimits, emptyLimitsSnapshot } from "./limits/index.ts";
import { limitsReads, localLimitsMachine, mergeMachineLimits, type LimitsReads } from "./limits/machines.ts";
import type { LimitsSnapshot } from "./limits/types.ts";
import { staticRoutes } from "./static-routes.ts";
import { localMachine } from "./public/machines.js";

const toolRoot = fileURLToPath(new URL(".", import.meta.url));
const publicRoot = join(toolRoot, "public");

const valueFlags = new Set([...analysisValueFlags, ...remoteValueFlags, "--port", "--snapshot"]);
const booleanFlags = new Set([...analysisBooleanFlags, ...remoteBooleanFlags, "--exclude-hidden", "--help", "--include-hidden", "--no-open", "--open", "--version", "--no-additional-providers", "--offline", "--no-codex-account"]);
// A repeated value would otherwise be silently first-wins; only --remote adds up.
const given = new Set<string>();
for (let index = 2; index < process.argv.length; index += 1) {
  const flag = process.argv[index];
  if (flag && valueFlags.has(flag) && flag !== "--remote" && given.has(flag)) {
    process.stderr.write(`Give ${flag} once.\n`);
    process.exit(2);
  }
  if (flag) given.add(flag);
  if (!flag?.startsWith("--") || (!valueFlags.has(flag) && !booleanFlags.has(flag))) {
    process.stderr.write("Unknown session analytics server argument. Run session-analytics dashboard --help.\n");
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
If a dashboard already uses the port, the command reuses it only when it runs the same version with the same analysis options.
  --snapshot FILE        Load a versioned full or shared snapshot; refresh re-reads that file and never scans local stores
  --exclude-hidden       Exclude hidden optional repository/session metadata
  --repo-id ID           Narrow to one stable repository ID
  --repo-name NAME       Narrow to one uniquely named repository
  --repo-root PATH       Narrow by canonical repository root
  --repo-remote URL      Narrow by canonical Git remote
${sourceHelp}${pricingHelp}${machineHelp}${remoteHelp}  --no-codex-account     Skip the banked-reset read through the Codex app-server
  --no-index             Full scan without reading or writing the index
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
  // The page names the running version, so a dashboard left open across an upgrade is recognisable.
  response.end(extname(path) === ".html" ? content.toString("utf8").replace("<!--version-->", version) : content);
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

function sameOriginApiRequest(request: { headers: Record<string, string | string[] | undefined> }): boolean {
  const site = request.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  if (Array.isArray(origin)) return false;
  try { return new URL(origin).host === request.headers.host; }
  catch { return false; }
}

const staticFiles = new Map(staticRoutes.map(([route, file]) => [route, join(publicRoot, file)]));

let analyzeOptions: import("./types.ts").AnalyzeOptions;
try { analyzeOptions = analyzeOptionsFrom(process.argv, process.env); }
catch (error) { process.stderr.write(`${optionErrorMessage(error)}\n`); process.exit(2); }
try { assertSnapshotOptions(process.argv); } catch {
  process.stderr.write("Snapshot input cannot be combined with analysis flags.\n");
  process.exit(2);
}
const snapshotFile = argument(process.argv, "--snapshot");
// A saved snapshot never scans, so saved machines and remote settings do not apply to it.
let remote: RemoteOptions = { machines: [], timeoutMs: 0, digest: null, local: "this machine" };
if (!snapshotFile) {
  try { remote = remoteFor(process.argv, process.env, analyzeOptions, (line) => process.stderr.write(`${line}\n`)); assertRemoteAnalysis(analyzeOptions, remote); }
  catch (error) { process.stderr.write(`${optionErrorMessage(error)}\n`); process.exit(2); }
}
const pricing = pricingConfiguration(analyzeOptions);
const scanOptions = {
  ...analyzeOptions,
  dataDir: dataDirectory(analyzeOptions),
  includeHidden: analyzeOptions.includeHidden !== false,
  additionalProviders: analyzeOptions.additionalProviders !== false,
  noIndex: analyzeOptions.noIndex === true,
  offline: pricing.offline,
  pricingPolicy: pricing.policy,
  pricingSources: pricing.sources,
  pricingMaxAgeDays: pricing.maxAgeDays,
};
const hashOf = (options: object): string => createHash("sha256").update(JSON.stringify(Object.fromEntries(
  Object.entries(options).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) =>
    [key, typeof value === "string" && (key.endsWith("Root") || key.endsWith("Path") || key === "dataDir") ? resolve(value) : value]),
))).digest("hex");
// Another set of machines is another dashboard; the same saved machines match a plain launch.
const scanHash = hashOf(scanOptions);
const optionsHashFor = (digest: string | null): string => hashOf({ ...scanOptions, ...(digest ? { machines: digest } : {}) });
let optionsHash = optionsHashFor(remote.digest);
const instanceToken = randomBytes(32).toString("hex");

const shutdown = new AbortController();
const dashboardPricing = createDashboardPricing(analyzeOptions, { snapshot: !!snapshotFile });
let analyticsPromise: Promise<MachineAnalytics | SharedSnapshot> | null = null;
let analyticsPending = false;
let scanProgress: ScanProgress | null = null;
let snapshotReady = false;
const machineLine = (line: string, failed: boolean): void => { (failed ? process.stderr : process.stdout).write(`${line}\n`); };
const machineScan = machineOptions(analyzeOptions);
let scanned: { snapshot: MachineAnalytics; ms: number } | null = null;
// Set while this machine's latest scan failed, so a machine that answers does not bring back the snapshot before it.
let scanFailed = false;
// Set when the saved machines changed during a scan, so the snapshot is rebuilt with the new ones once it is done.
let machinesChanged = false;

/**
 * Other machines are read on their own: a snapshot is served once this machine's scan is done, with the
 * last good snapshot of a machine still reading, and is rebuilt as each machine answers.
 */
function readsFor(options: RemoteOptions): MachineReads | null {
  if (snapshotFile || !options.machines.length) return null;
  const reads: MachineReads = machineReads(machineScan, options, {
    report: machineLine, signal: shutdown.signal, preload: true,
    onSettle: () => {
      if (reads !== machines || !scanned || analyticsPending || scanFailed) return;
      try { analyticsPromise = Promise.resolve(reads.combine(scanned.snapshot, scanned.ms)); }
      catch { process.stderr.write("A machine's snapshot could not be combined; the previous snapshot stays.\n"); }
    },
  });
  return reads;
}
let machines = readsFor(remote);
const limitsOptions = { ...analyzeOptions, codexAccount: !process.argv.includes("--no-codex-account") };
/** The same machines' limits, read each time this machine harvests its own. */
function limitReadsFor(options: RemoteOptions): LimitsReads | null {
  if (snapshotFile || !options.machines.length) return null;
  return limitsReads(limitsOptions, options, { report: (line) => process.stderr.write(`${line}\n`), signal: shutdown.signal, preload: true });
}
let limitMachines = limitReadsFor(remote);

// A local failure fails this refresh only: reads of other machines carry on, and their last good snapshots stay.
async function scanWithMachines(reads: MachineReads, hooks: AnalysisHooks): Promise<MachineAnalytics> {
  void reads.start();
  const started = performance.now();
  const [snapshot] = await Promise.all([analyzeMachineSessionsIsolated(machineScan, hooks).catch((error: unknown) => { scanFailed = true; throw error; }), reads.loaded]);
  scanned = { snapshot, ms: performance.now() - started };
  scanFailed = false;
  return reads.combine(snapshot, scanned.ms);
}

/**
 * The snapshot again from this machine's last scan and the current machines; with no machines left, that scan alone.
 * A dashboard without a usable scan (one started without machines scans with local IDs) scans now, not on the next request.
 */
function rebuild(): void {
  if (analyticsPending) { machinesChanged = true; return; }
  const reads = machines;
  if (!reads) { analyticsPromise = scanned && !scanFailed ? Promise.resolve(scanned.snapshot) : null; return; }
  if (!scanned || scanFailed) { analyticsPromise = null; void analytics(true).catch(() => {}); return; }
  void reads.start();
  analyticsPromise = reads.loaded.then(() => reads.combine(scanned!.snapshot, scanned!.ms));
}

// A dashboard that reads the saved machines follows machines.json, so machines add, set, rename and remove reach it
// on its next request, and a plain launch afterwards reuses it. --remote, --no-remote and the variable fix the set.
const followsSaved = !snapshotFile && !process.argv.includes("--remote") && !process.argv.includes("--no-remote")
  && (process.argv.includes("--machines") || !process.env["SESSION_ANALYTICS_REMOTE"]);
const machinesStamp = (): string => {
  try { const info = statSync(machinesPath(analyzeOptions)); return `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`; } catch { return "none"; }
};
let followedStamp = followsSaved ? machinesStamp() : "";
function followMachines(): void {
  if (!followsSaved) return;
  const stamp = machinesStamp();
  if (stamp === followedStamp) return;
  followedStamp = stamp;
  let next: RemoteOptions;
  try { next = remoteFor(process.argv, process.env, analyzeOptions); assertRemoteAnalysis(analyzeOptions, next); }
  catch (error) { process.stderr.write(`${optionErrorMessage(error)} This dashboard keeps reading the machines it had.\n`); return; }
  if (next.digest === remote.digest && next.local === remote.local) return;
  machines?.abort();
  limitMachines?.abort();
  remote = next;
  optionsHash = optionsHashFor(remote.digest);
  machines = readsFor(remote);
  limitMachines = limitReadsFor(remote);
  process.stdout.write(`Saved machines changed; now reading ${remote.local}${remote.machines.length ? ` and ${remote.machines.map(({ name }) => name).join(", ")}` : " only"}.\n`);
  rebuild();
}

/** Every machine as it stands now; the dashboard polls this while a machine is still reading. */
function machineStatuses(): MachineStatus[] {
  if (!machines) return [];
  const local: MachineStatus = { key: localMachine, label: remote.local, state: scanned && !analyticsPending ? "ok" : "reading", sessions: scanned?.snapshot.summary.sessions ?? 0,
    repositories: scanned?.snapshot.summary.repositories ?? 0, readAt: scanned?.snapshot.generatedAt ?? null, durationMs: scanned ? Math.round(scanned.ms) : null, version };
  return [local, ...machines.readings.map(({ status }) => status)];
}

function analytics(refresh = false): Promise<MachineAnalytics | SharedSnapshot> {
  if (analyticsPending && analyticsPromise) return analyticsPromise;
  if (refresh || !analyticsPromise) {
    analyticsPending = true;
    const current: ScanProgress = { phase: "discover", done: 0, total: null, startedAt: new Date().toISOString(), fullParse: false };
    scanProgress = current;
    const hooks: AnalysisHooks = {
      onFullParse() { current.fullParse = true; noticeFullParse(); },
      onProgress(progress) { current.phase = progress.phase; current.done = progress.done; current.total = progress.total; },
    };
    // A scan without machines uses local IDs, so it cannot be combined with machines added later.
    if (!machines) scanned = null;
    // Reserve the analytics flight before awaiting pricing, so every concurrent request shares the whole refresh.
    analyticsPromise = (async () => {
      if (refresh) await dashboardPricing.check("manual");
      const pricingRevision = dashboardPricing.revision();
      // Machines can change while a price request is pending; use the current readers when the scan actually starts.
      const result = await (snapshotFile ? loadSnapshot(snapshotFile) : machines ? scanWithMachines(machines, hooks) : analyzeMachines(analyzeOptions, remote, machineLine, shutdown.signal, hooks));
      dashboardPricing.applied(pricingRevision);
      if (!("kind" in result) && dashboardPricing.enabled) {
        const unmatched = new Set(result.sessions.filter(({ costBasis }) => costBasis !== "provider-reported")
          .flatMap(({ models }) => models.filter((model) => model.inputTokens + model.outputTokens > 0 && !model.priced && !model.pricing?.length)
            .map(({ model }) => model)));
        if (unmatched.size) void dashboardPricing.check("unpriced", unmatched);
      }
      return result;
    })()
      .then((result) => {
        snapshotReady = true;
        return result;
      })
      .finally(() => {
        analyticsPending = false;
        scanProgress = null;
        if (machinesChanged) { machinesChanged = false; rebuild(); }
      });
  }
  return analyticsPromise;
}

// Limit meters are harvested incrementally in this process (new log tails only) and shared by concurrent requests.
let limitsPromise: Promise<{ snapshot: LimitsSnapshot; ms: number }> | null = null;
let limitsAt = 0;
let limitsPending = false;
/**
 * A harvest still running is always shared, however old: a second one would only re-read the same tails. Other machines
 * are read at the same time and never hold this machine's meters back: each request merges the machines as they stand,
 * one still reading shown from its last good limits, and the page asks again while one is reading.
 */
function limits(refresh: boolean): Promise<LimitsSnapshot> {
  if (snapshotFile) return Promise.resolve(emptyLimitsSnapshot("snapshot"));
  const reads = limitMachines;
  const fresh = limitsPromise !== null && (limitsPending || Date.now() - limitsAt < (refresh ? 5_000 : 30_000));
  if (!fresh) {
    limitsAt = Date.now();
    limitsPending = true;
    const started = performance.now();
    limitsPromise = collectLimits({ ...limitsOptions, settle: false })
      .then((snapshot) => ({ snapshot, ms: performance.now() - started }))
      .finally(() => { limitsPending = false; })
      .catch((error: unknown) => { limitsPromise = null; throw error; });
  }
  const harvest = limitsPromise!;
  // Machines that changed since the last harvest are read now rather than at the next one.
  if (reads && (!fresh || reads.readings.some(({ pending, status }) => !pending && status.state === "reading"))) void reads.start(harvest.then(({ snapshot }) => snapshot, () => null));
  return Promise.all([harvest, reads?.loaded]).then(([{ snapshot, ms }]) =>
    mergeMachineLimits(snapshot, localLimitsMachine(remote.local, snapshot, ms), reads?.current() ?? [], machines?.profileKeys() ?? null));
}

process.on("unhandledRejection", () => {
  process.stderr.write("Session analytics encountered an unexpected asynchronous failure; the server is still running.\n");
});

const server = createServer(async (request, response) => {
  let url: URL | undefined;
  try {
    if (!loopbackRequest(request)) {
      sendJson(response, 403, { error: "Session analytics accepts loopback requests only." });
      return;
    }
    url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/api/") && !sameOriginApiRequest(request)) {
      sendJson(response, 403, { error: "Session analytics accepts same-origin API requests only." });
      return;
    }
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Session analytics is read-only." });
      return;
    }
    if (url.pathname.startsWith("/api/")) followMachines();
    if (url.pathname === "/api/health") {
      const health: DashboardHealth = {
        service: serviceId,
        dataSource: snapshotFile ? "snapshot" : "live",
        snapshot: snapshotReady ? "ready" : analyticsPending ? "building" : "not-started",
        status: "ok",
        instanceToken,
        optionsHash,
        scanHash,
        version,
      };
      if (dashboardPricing.enabled) health.pricing = dashboardPricing.status();
      sendJson(response, 200, health);
      return;
    }
    if (url.pathname === "/api/analytics") {
      const result = analytics(url.searchParams.get("refresh") === "1");
      // ?wait=SECONDS answers 202 while the scan runs on, so a browser never holds one request open for a scan of
      // several minutes (Safari drops a fetch that waits about a minute); the dashboard asks again.
      const wait = Number(url.searchParams.get("wait"));
      if (Number.isFinite(wait) && wait > 0) {
        let timer: NodeJS.Timeout | undefined;
        const pending = new Promise<null>((done) => { timer = setTimeout(() => done(null), Math.min(wait, 30) * 1_000); });
        const settled = await Promise.race([result, pending]).finally(() => clearTimeout(timer));
        if (settled === null) { sendJson(response, 202, { pending: true, progress: scanProgress } satisfies PendingAnalytics); return; }
        sendJson(response, 200, settled);
        return;
      }
      sendJson(response, 200, await result);
      return;
    }
    if (url.pathname === "/api/machines") {
      // read=1 reads the other machines again without scanning this one, as after fixing one of them.
      if (url.searchParams.get("read") === "1" && machines && scanned && !scanFailed && !analyticsPending) void machines.start();
      sendJson(response, 200, { machines: machineStatuses() });
      return;
    }
    if (url.pathname === "/api/limits") {
      sendJson(response, 200, await limits(url.searchParams.get("refresh") === "1"));
      return;
    }
    const path = staticFiles.get(url.pathname);
    if (path) {
      await sendFile(response, path);
      return;
    }
    sendJson(response, 404, { error: "Not found." });
  } catch (error) {
    if (!url) {
      sendJson(response, 400, { error: "Bad request." });
      return;
    }
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
  process.stderr.write("Session analytics port must be an integer from 1024 through 65535.\n");
  process.exit(2);
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
      if (error) process.stderr.write("Could not open the browser; open the dashboard URL manually.\n");
      resolve();
    });
  });
}

async function runningDashboard(): Promise<Partial<DashboardHealth> | null> {
  try {
    const response = await fetch(`${dashboardUrl}/api/health`, { signal: AbortSignal.timeout(2_000) });
    return response.ok ? await response.json() as Partial<DashboardHealth> : null;
  } catch {
    return null;
  }
}

function launchToken(): string | null {
  try { return readDashboardToken(analyzeOptions, port); } catch { return null; }
}

server.on("error", (error: NodeJS.ErrnoException) => {
  void (async () => {
    if (error.code !== "EADDRINUSE") {
      process.stderr.write(`${brand.name} could not start: ${safeError(error)}\n`);
      process.exit(1);
    }
    // A saved-file dashboard never reuses the port: that server could be showing another file.
    const refusal = reuseRefusal(await runningDashboard(), { version, optionsHash, scanHash, instanceToken: snapshotFile ? null : launchToken() });
    if (refusal) {
      process.stderr.write(`${refusal}\n`);
      process.exit(1);
    }
    process.stdout.write(`${brand.name} already running: ${dashboardUrl}\n`);
    if (process.argv.includes("--open")) await openDashboard();
    process.exit(0);
  })();
});

server.listen(port, "127.0.0.1", () => {
  try { writeDashboardToken(analyzeOptions, port, instanceToken); }
  catch {
    process.stderr.write("Session Analytics could not store its private dashboard token.\n");
    server.close(() => process.exit(1));
    return;
  }
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
      // Startup remains local-first; later checks only update the cache and a content-free health hint.
      void dashboardPricing.check();
    })
    .catch((error) => {
      if (!shutdown.signal.aborted) process.stderr.write(`Session analytics warmup failed: ${safeError(error)}\n`);
    });
  dashboardPricing.start();
  if (process.argv.includes("--open")) {
    void warmup.then(openDashboard, openDashboard);
  }
});

// In-flight requests are not awaited: remote reads, workers and connections stop at once.
stopOnSignals(() => {
  dashboardPricing.stop();
  shutdown.abort();
  server.close();
  server.closeAllConnections();
}, 0);
