#!/usr/bin/env node
/**
 * Install a packed session-analytics tarball, or a registry spec, into a temporary prefix whose path contains a space,
 * and run it the way a user would: every command's help and version, the synthetic demo report (compared with this
 * checkout's), MCP, the dashboard with every static file, a saved machine read through a stand-in `ssh` with the bundled
 * runtime, and a read-only installation; then print the tested tarball's SHA-256 and npm integrity. Reads synthetic data
 * only and never uses the real data directory, the global npm prefix or a real SSH connection.
 *
 *   node scripts/smoke-installed.ts release/session-analytics-X.Y.Z.tgz [--port PORT]
 *   node scripts/smoke-installed.ts session-analytics@X.Y.Z
 */
import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, extname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { validateSnapshot } from "../src/interop/snapshot.ts";
import { staticRoutes } from "../src/static-routes.ts";
import type { LimitsSnapshot } from "../src/limits/types.ts";
import type { MachineAnalytics } from "../src/types.ts";
import { version } from "../src/version.ts";
import { fakeSsh } from "../test/fake-ssh.ts";
import { createSessionAnalyticsFixture } from "../test/fixtures.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The limits snapshot version this checkout serves; a schema change fails the typecheck here instead of the smoke. */
const limitsSchemaVersion: LimitsSnapshot["schemaVersion"] = 2;
const commands = ["dashboard", "report", "rates", "export", "merge", "index", "mcp", "limits", "machines"];
const providers = ["claude", "codex", "cursor", "copilot", "opencode", "gemini"];
const forbidden = /PRIVATE_DEMO_CONTENT_SENTINEL|synthetic demo prompt|synthetic demo response|synthetic tool result|synthetic-demo-only|session-analytics-demo-|\/repos\/|\/projects\//;
const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8", ".woff2": "font/woff2",
};

/**
 * What two builds must agree on for the same synthetic data: each session's timing, tokens and cents, the repository
 * set and cent-rounded totals. Session keys are keyed per data directory and float sums depend on order, so neither is compared.
 */
function stableProjection(snapshot: MachineAnalytics): unknown {
  const cents = (value: unknown): unknown => typeof value === "number" ? Math.round(value * 100) : value;
  return {
    sessions: snapshot.sessions.map(({ provider, firstEventAt, lastEventAt, tokens, cost }) =>
      [provider, firstEventAt, lastEventAt, tokens.inputTokens, tokens.outputTokens, cents(cost.totalUsd)].join(" ")).sort(),
    repositories: snapshot.repositories.map(({ repository }) => repository.id).sort(), warnings: [...snapshot.warnings].sort(),
    summary: Object.fromEntries(Object.entries(snapshot.summary).sort().map(([key, value]) => [key, cents(value)])),
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

/** Stop a demo wrapper with SIGTERM, which it forwards to its session-analytics child before removing its synthetic data; SIGKILL only if that hangs. */
async function stop(child: ChildProcess, signals: Array<NodeJS.Signals | null>): Promise<void> {
  for (const signal of signals) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit").catch(() => undefined);
    if (signal) child.kill(signal);
    await Promise.race([exited, delay(10_000, undefined, { ref: false })]);
  }
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
  // Every demo run generates the same sessions, so the installed build and this checkout analyze identical data. Each run
  // names its build with --bin, so an exported SESSION_ANALYTICS_DEMO_BIN cannot replace the checkout baseline.
  const demoEnvironment: NodeJS.ProcessEnv = { ...process.env, PATH: path, SESSION_ANALYTICS_DEMO_NOW: new Date().toISOString() };
  delete demoEnvironment["SESSION_ANALYTICS_DEMO_BIN"];
  const demo = (demoArgs: string[], label: string): string =>
    ran(spawnSync(process.execPath, [join(root, "scripts/demo.ts"), ...demoArgs], { cwd: work, env: demoEnvironment, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 300_000 }), label);
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
      // Every synthetic source is readable, so a read warning means this runtime lost sessions that two equal runs would both miss.
      const unread = snapshot.warnings.filter((warning) => /could not be|unsupported schema/.test(warning));
      check(!unread.length, `${label} could not read a synthetic source: ${unread.join(" ")}`);
      return snapshot;
    };
    const installed = report("installed demo report");
    // Cursor sessions come from a separate worker that runs only when a Cursor database exists.
    const cursor = installed.sessions.filter((session) => session.provider === "cursor").length;
    check(cursor > 0, "the Cursor worker returned no sessions");
    const source = report("source demo report", ["--bin", join(root, "bin/session-analytics.ts")]);
    check(JSON.stringify(stableProjection(installed)) === JSON.stringify(stableProjection(source)), "the installed report differs from this checkout's");
    console.log(`Installed demo report matches this checkout (${installed.sessions.length} sessions, six providers, ${cursor} from the Cursor worker).`);

    const mcp = spawn(process.execPath, [join(root, "scripts/demo.ts"), "mcp", "--bin", bin], { cwd: work, env: demoEnvironment, stdio: ["pipe", "pipe", "ignore"] });
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
      await stop(mcp, [null, "SIGTERM", "SIGKILL"]);
    }

    const port = requestedPort ?? await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const dashboard = spawn(process.execPath, [join(root, "scripts/demo.ts"), "--no-open", "--port", String(port), "--bin", bin], { cwd: work, env: demoEnvironment, stdio: "ignore" });
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
      check(limits.status === 200, `/api/limits returned ${limits.status}`);
      const limitsVersion = (await limits.json() as { schemaVersion?: unknown }).schemaVersion;
      check(limitsVersion === limitsSchemaVersion, `/api/limits served schema version ${String(limitsVersion)}, expected ${limitsSchemaVersion}`);
      const exited = once(dashboard, "exit");
      dashboard.kill("SIGTERM");
      check(await Promise.race([exited.then(() => true), delay(15_000, undefined, { ref: false }).then(() => false)]), "the dashboard did not stop on SIGTERM");
      check(await fetch(`${origin}/api/health`).then(() => false, () => true), "the dashboard still answers after SIGTERM");
      console.log(`Dashboard serves ${staticRoutes.length} static files, /api/analytics, /api/limits and /api/health at ${version}, and stops on SIGTERM.`);
    } finally {
      await stop(dashboard, ["SIGTERM", "SIGKILL"]);
    }

    // A saved machine is read with the bundled runtime: the installed bin packs its own compiled files, the stand-in ssh runs
    // the bootstrap under a separate HOME, which installs them there and runs the report. A missing bootstrap or runtime fails here.
    const fake = join(work, "fake-ssh"), homes = join(fake, "homes"), sshLog = join(fake, "ssh.log");
    mkdirSync(join(fake, "bin"), { recursive: true });
    writeFileSync(join(fake, "bin", "ssh"), fakeSsh, { mode: 0o755 });
    const remote = await createSessionAnalyticsFixture(join(fake, "remote"));
    const machineEnvironment: NodeJS.ProcessEnv = {
      ...environment, PATH: `${join(fake, "bin")}${delimiter}${path}`, FAKE_SSH_LOG: sshLog, FAKE_SSH_HOMES: homes,
      FAKE_SSH_ENVS: JSON.stringify({ smokebox: {
        SESSION_ANALYTICS_ADDITIONAL_PROVIDERS: "0", SESSION_ANALYTICS_DATA_DIR: join(fake, "remote-data"), SESSION_ANALYTICS_CLAUDE_ROOT: remote.claudeRoot,
        SESSION_ANALYTICS_CODEX_ROOT: remote.codexRoot, SESSION_ANALYTICS_CODEX_ARCHIVE_ROOT: remote.codexArchiveRoot,
        SESSION_ANALYTICS_CONDUCTOR_DATABASE: remote.databasePath, SESSION_ANALYTICS_CURSOR_DATABASE: remote.cursorDatabasePath,
      } }),
    };
    const machinesCli = (cliArgs: string[]): string => ran(spawnSync(bin, cliArgs, { cwd: work, env: machineEnvironment, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 180_000 }), `session-analytics ${cliArgs.join(" ")}`);
    machinesCli(["machines", "add", "smokebox", "--no-check"]);
    const calls = (): string[][] => readFileSync(sshLog, "utf8").split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { words: string[] }).words.slice(2, 4));
    for (const [round, expected] of [["first", [["sa1", "run"], ["sa1", "install"]]], ["second", [["sa1", "run"]]]] as const) {
      rmSync(sshLog, { force: true });
      const combined = validateSnapshot(JSON.parse(machinesCli(["report", "--json", "--no-index"])));
      const read = combined.machines?.find((machine) => machine.key === "smokebox");
      check(read?.state === "ok" && read.version === version && read.sessions > 0, `the ${round} bundled-runtime read reports ${JSON.stringify(read ?? null)}`);
      check(combined.sessions.filter((session) => session.machine === "smokebox").length === read.sessions, `the ${round} read's sessions are not tagged with their machine`);
      // The first read installs the runtime; the second runs the verified copy without sending it again.
      check(JSON.stringify(calls()) === JSON.stringify(expected), `the ${round} read sent ${JSON.stringify(calls())}`);
    }
    const runtimes = join(homes, "smokebox", "ssh-user", ".cache", "session-analytics", "runtime");
    const installedRuntime = readdirSync(runtimes).filter((name) => name.startsWith(`${version}-`));
    check(installedRuntime.length === 1 && existsSync(join(runtimes, installedRuntime[0]!, "bin", "session-analytics.js")), "the bundled runtime is not the compiled package");
    console.log("A saved machine reads through the bundled runtime: installed once, then run from the verified copy.");

    ran(spawnSync("chmod", ["-R", "a-w", packageRoot], { encoding: "utf8" }), "chmod");
    check(report("read-only installed demo report").sessions.length === installed.sessions.length, "the read-only installation reports differently");
    console.log("A read-only installation runs the same report.");

    // A registry install is hashed from the tarball npm verified into this cache, so both name the bytes that ran.
    const tested = tarball ?? join(work, (JSON.parse(ran(spawnSync("npm", ["pack", spec, "--json", "--ignore-scripts", "--pack-destination", work, "--cache", join(work, "npm-cache"), "--prefer-offline"],
      { cwd: work, env: { ...process.env, PATH: path }, encoding: "utf8", timeout: 300_000 }), `npm pack ${spec}`)) as Array<{ filename: string }>)[0]!.filename);
    const bytes = readFileSync(tested);
    console.log(`sha256 ${createHash("sha256").update(bytes).digest("hex")}`);
    console.log(`integrity sha512-${createHash("sha512").update(bytes).digest("base64")}`);
  } finally {
    spawnSync("chmod", ["-R", "u+w", work]);
    rmSync(work, { recursive: true, force: true });
  }
}

try { await main(); } catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Installed smoke failed."}\n`);
  process.exitCode = 1;
}
