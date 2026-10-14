#!/usr/bin/env node
/**
 * Install a packed session-analytics tarball, or a registry spec, into a temporary prefix whose path contains a space,
 * and run it the way a user would: every command's help and version, the synthetic demo report (compared with this
 * checkout's), MCP, the dashboard with every static file, and a read-only installation. Reads synthetic data only and
 * never uses the real data directory or the global npm prefix.
 *
 *   node scripts/smoke-installed.ts release/session-analytics-X.Y.Z.tgz [--port PORT]
 *   node scripts/smoke-installed.ts session-analytics@X.Y.Z
 */
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, extname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { validateSnapshot } from "../src/interop/snapshot.ts";
import { staticRoutes } from "../src/static-routes.ts";
import type { MachineAnalytics } from "../src/types.ts";
import { version } from "../src/version.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commands = ["dashboard", "report", "rates", "export", "merge", "index", "mcp", "limits"];
const providers = ["claude", "codex", "cursor", "copilot", "opencode", "gemini"];
const forbidden = /PRIVATE_DEMO_CONTENT_SENTINEL|synthetic demo prompt|synthetic demo response|synthetic tool result|synthetic-demo-only|session-analytics-demo-|\/repos\/|\/projects\//;
const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8", ".woff2": "font/woff2",
};

/** Counts, provider and repository sets and cent-rounded totals: what must match between builds, run to run. */
function stableProjection(snapshot: MachineAnalytics): unknown {
  const byProvider: Record<string, number> = {};
  for (const session of snapshot.sessions) byProvider[session.provider] = (byProvider[session.provider] ?? 0) + 1;
  return {
    sessions: snapshot.sessions.length, byProvider: Object.fromEntries(Object.entries(byProvider).sort()),
    repositories: snapshot.repositories.map(({ repository }) => repository.id).sort(), warnings: [...snapshot.warnings].sort(),
    summary: Object.fromEntries(Object.entries(snapshot.summary).sort().map(([key, value]) => [key, typeof value === "number" ? Math.round(value * 100) / 100 : value])),
  };
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Installed smoke failed: ${message}`);
}

function ran(result: SpawnSyncReturns<string>, label: string): string {
  if (result.error || result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr.slice(-4000));
    throw new Error(`Installed smoke failed: ${label} exited ${result.status ?? result.signal ?? result.error?.message}.`);
  }
  return result.stdout;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const address = probe.address();
  await new Promise<void>((done) => probe.close(() => done()));
  check(address && typeof address === "object", "no free loopback port");
  return address.port;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const portIndex = args.indexOf("--port");
  const requestedPort = portIndex >= 0 ? Number(args.splice(portIndex, 2)[1]) : null;
  if (args.length !== 1 || (requestedPort !== null && !(Number.isInteger(requestedPort) && requestedPort >= 1024 && requestedPort <= 65_535))) {
    throw new Error("Usage: node scripts/smoke-installed.ts <tarball | registry spec> [--port PORT]");
  }
  const tarball = existsSync(args[0]!) ? resolve(args[0]!) : null;
  const spec = tarball ?? args[0]!;
  const work = mkdtempSync(join(tmpdir(), "session-analytics-smoke-"));
  const prefix = join(work, "prefix with space"), packageRoot = join(prefix, "lib", "node_modules", "session-analytics");
  const bin = join(prefix, "bin", "session-analytics");
  // The shebang resolves `node` from PATH, so this runtime goes first; npm keeps the caller's configuration.
  const path = `${dirname(process.execPath)}${delimiter}${process.env["PATH"] ?? ""}`;
  const environment: NodeJS.ProcessEnv = { PATH: path, HOME: join(work, "home"), SESSION_ANALYTICS_DATA_DIR: join(work, "data"), SESSION_ANALYTICS_OFFLINE: "1" };
  for (const key of ["LANG", "LC_ALL", "TMPDIR", "TZ"]) if (process.env[key]) environment[key] = process.env[key];
  mkdirSync(environment["HOME"]!);
  const demo = (demoArgs: string[], label: string): string =>
    ran(spawnSync(process.execPath, [join(root, "scripts/demo.ts"), ...demoArgs], { cwd: work, env: { ...process.env, PATH: path }, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 300_000 }), label);
  try {
    ran(spawnSync("npm", ["install", "--global", "--prefix", prefix, "--cache", join(work, "npm-cache"), "--ignore-scripts", "--no-audit", "--no-fund",
      ...(tarball ? ["--offline"] : []), spec], { env: { ...process.env, PATH: path }, encoding: "utf8", timeout: 300_000 }), `npm install ${spec}`);
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as Record<string, unknown>;
    check(manifest["version"] === version, `installed ${String(manifest["version"])}, but this checkout is ${version}`);
    check(!manifest["scripts"] && !manifest["dependencies"], "the installed manifest has scripts or dependencies");
    console.log(`Installed session-analytics@${version} from ${tarball ? "the tarball" : spec} into a prefix whose path contains a space.`);

    const cli = (cliArgs: string[]): string => ran(spawnSync(bin, cliArgs, { cwd: work, env: environment, encoding: "utf8", timeout: 60_000 }), `session-analytics ${cliArgs.join(" ")}`);
    check(cli(["--version"]).trim() === version, "--version");
    check(/session-analytics/i.test(cli(["--help"])), "--help");
    for (const command of commands) {
      check(/session-analytics/i.test(cli([command, "--help"])), `${command} --help`);
      check(cli([command, "--version"]).trim() === version, `${command} --version`);
    }
    console.log(`Help and version pass for the bin and ${commands.length} commands.`);

    const report = (label: string, demoArgs: string[] = ["--bin", bin]): MachineAnalytics => {
      const json = demo(["report", "--json", ...demoArgs], label);
      check(!forbidden.test(json), `${label} contains private fixture content`);
      const snapshot = validateSnapshot(JSON.parse(json));
      check(providers.every((provider) => snapshot.sessions.some((session) => session.provider === provider)), `${label} lacks one of the six providers`);
      return snapshot;
    };
    const installed = report("installed demo report");
    // Cursor sessions come from a separate worker that runs only when a Cursor database exists.
    const cursor = installed.sessions.filter((session) => session.provider === "cursor").length;
    check(cursor > 0, "the Cursor worker returned no sessions");
    check(JSON.stringify(stableProjection(installed)) === JSON.stringify(stableProjection(report("source demo report", []))), "the installed report differs from this checkout's");
    console.log(`Installed demo report matches this checkout (${installed.sessions.length} sessions, six providers, ${cursor} from the Cursor worker).`);

    const mcp = spawn(process.execPath, [join(root, "scripts/demo.ts"), "mcp", "--bin", bin], { cwd: work, env: { ...process.env, PATH: path }, stdio: ["pipe", "pipe", "ignore"] });
    try {
      let buffered = "";
      const responses = new Map<number, Record<string, any>>();
      mcp.stdout.setEncoding("utf8");
      mcp.stdout.on("data", (chunk: string) => {
        buffered += chunk;
        for (let newline = buffered.indexOf("\n"); newline >= 0; newline = buffered.indexOf("\n")) {
          const message = JSON.parse(buffered.slice(0, newline)) as Record<string, any>;
          buffered = buffered.slice(newline + 1);
          if (typeof message["id"] === "number") responses.set(message["id"], message);
        }
      });
      const call = async (id: number, method: string, params: object): Promise<Record<string, any>> => {
        mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        for (const deadline = Date.now() + 300_000; !responses.has(id); await delay(50)) check(Date.now() < deadline && mcp.exitCode === null, `MCP ${method} did not answer`);
        return responses.get(id)!;
      };
      const initialized = await call(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "smoke-installed", version } });
      check(initialized["result"]?.serverInfo?.version === version, "MCP initialize");
      mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      const summary = await call(2, "tools/call", { name: "usage_summary", arguments: { window: "all" } });
      check(summary["result"]?.isError === false && summary["result"]?.structuredContent, "MCP usage_summary");
      console.log("MCP initialize and usage_summary pass.");
    } finally {
      mcp.stdin.end();
      if (mcp.exitCode === null) await Promise.race([once(mcp, "exit"), delay(10_000, undefined, { ref: false }).then(() => mcp.kill("SIGKILL"))]);
    }

    const port = requestedPort ?? await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const dashboard = spawn(process.execPath, [join(root, "scripts/demo.ts"), "--no-open", "--port", String(port), "--bin", bin], { cwd: work, env: { ...process.env, PATH: path }, stdio: "ignore" });
    try {
      let health: Record<string, unknown> | null = null;
      for (const deadline = Date.now() + 120_000; !health; await delay(100)) {
        check(Date.now() < deadline && dashboard.exitCode === null, "the dashboard did not start");
        try { const response = await fetch(`${origin}/api/health`); if (response.ok) health = await response.json() as Record<string, unknown>; } catch { /* Starting. */ }
      }
      check(health["service"] === "session-analytics" && health["status"] === "ok" && health["version"] === version, `/api/health reports ${String(health["version"])}`);
      for (const [route, file] of staticRoutes) {
        const response = await fetch(origin + route);
        const body = Buffer.from(await response.arrayBuffer());
        check(response.status === 200 && body.length > 0, `${route} returned ${response.status}`);
        check(response.headers.get("content-type") === contentTypes[extname(file)], `${route} content type ${response.headers.get("content-type")}`);
        if (route === "/") check(body.toString("utf8").includes(`Session Analytics ${version}.`), "the dashboard page does not name its version");
      }
      const analytics = await fetch(`${origin}/api/analytics`);
      check(analytics.status === 200, `/api/analytics returned ${analytics.status}`);
      check(validateSnapshot(await analytics.json()).sessions.length === installed.sessions.length, "/api/analytics differs from the report");
      const limits = await fetch(`${origin}/api/limits`);
      check(limits.status === 200 && (await limits.json() as { schemaVersion?: unknown }).schemaVersion === 1, `/api/limits returned ${limits.status}`);
      const exited = once(dashboard, "exit");
      dashboard.kill("SIGTERM");
      check(await Promise.race([exited.then(() => true), delay(15_000, undefined, { ref: false }).then(() => false)]), "the dashboard did not stop on SIGTERM");
      check(await fetch(`${origin}/api/health`).then(() => false, () => true), "the dashboard still answers after SIGTERM");
      console.log(`Dashboard serves ${staticRoutes.length} static files, /api/analytics, /api/limits and /api/health at ${version}, and stops on SIGTERM.`);
    } finally {
      if (dashboard.exitCode === null && dashboard.signalCode === null) dashboard.kill("SIGKILL");
    }

    ran(spawnSync("chmod", ["-R", "a-w", packageRoot], { encoding: "utf8" }), "chmod");
    check(report("read-only installed demo report").sessions.length === installed.sessions.length, "the read-only installation reports differently");
    console.log("A read-only installation runs the same report.");

    if (tarball) {
      const bytes = readFileSync(tarball);
      console.log(`sha256 ${createHash("sha256").update(bytes).digest("hex")}`);
      console.log(`integrity sha512-${createHash("sha512").update(bytes).digest("base64")}`);
    } else {
      const lock = JSON.parse(readFileSync(join(prefix, "lib", "node_modules", ".package-lock.json"), "utf8")) as { packages?: Record<string, { resolved?: string; integrity?: string }> };
      const entry = lock.packages?.["node_modules/session-analytics"];
      console.log(`resolved ${entry?.resolved ?? "unknown"}\nintegrity ${entry?.integrity ?? "unknown"}`);
    }
  } finally {
    spawnSync("chmod", ["-R", "u+w", work]);
    rmSync(work, { recursive: true, force: true });
  }
}

try { await main(); } catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Installed smoke failed."}\n`);
  process.exitCode = 1;
}
