import { resolve } from "node:path";
import { brand } from "../brand.ts";
import { version } from "../version.ts";
import { analysisValueFlags, analyzeOptionsFrom, setting } from "../options.ts";
import { serveMcp } from "./server.ts";

const argv = process.argv.slice(2);
const valueFlags = new Set([...analysisValueFlags, "--mcp-ttl", "--mcp-cwd"]);
const booleanFlags = new Set(["--exclude-hidden", "--include-hidden", "--help", "--version"]);
let invalid = false;
for (let index = 0; index < argv.length; index += 1) {
  const flag = argv[index]!;
  if (!valueFlags.has(flag) && !booleanFlags.has(flag)) { invalid = true; break; }
  if (valueFlags.has(flag)) {
    if (!argv[index + 1] || argv[index + 1]!.startsWith("--")) { invalid = true; break; }
    index += 1;
  }
}
if (invalid) {
  process.stderr.write("Invalid MCP launch arguments. Run mcp --help for supported options.\n");
  process.exitCode = 2;
} else if (argv.includes("--help")) {
  process.stdout.write(`${brand.name} ${version}

Usage: ${brand.command} mcp [options]

Metrics-only MCP server over stdio. No HTTP listener, network requests, or transcript output.
Tools default to the launch repository when known; all timestamps and calendar windows use UTC.
The first tool call scans local history; initialize, discovery, tools/list and ping do not scan.

  --mcp-ttl SECONDS      Snapshot cache TTL after completion, 1–3600 (default 60)
  --mcp-cwd PATH         Trusted launch context (default CLAUDE_PROJECT_DIR, then process cwd)
  --repo-id ID           Restrict all requests to this repository key
  --repo-name NAME       Restrict all requests to one uniquely named repository
  --repo-root PATH       Restrict all requests to this canonical repository root
  --repo-remote URL      Restrict all requests to this registered remote
  --exclude-hidden      Exclude hidden optional metadata
  --claude-root PATH     Override Claude projects; replaces provider discovery
  --codex-root PATH      Override Codex sessions; replaces provider discovery
  --codex-archive-root PATH Override archived Codex sessions
  --cursor-database PATH Override the Cursor history database
  --database PATH        Override optional Conductor metadata
  --rate-card PATH       Override the reviewed rate card
  --version              Print the version
  --help                 Show this help

Flags override SESSION_ANALYTICS_* settings, including MCP_TTL and MCP_CWD.
Paths are accepted only at process launch, never from tool arguments or client roots.
Allow up to 180 seconds for the first scan on large histories. Later calls reuse the cache.
`);
} else if (argv.includes("--version")) {
  process.stdout.write(`${version}\n`);
} else {
  const rawTtl = setting(argv, process.env, "--mcp-ttl", "MCP_TTL") ?? "60";
  const ttl = /^\d+$/.test(rawTtl) ? Number(rawTtl) : NaN;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 3600) {
    process.stderr.write("MCP cache TTL must be an integer from 1 through 3600 seconds.\n");
    process.exitCode = 2;
  } else {
    const analysis = analyzeOptionsFrom(argv, process.env);
    analysis.mcpCwd = resolve(setting(argv, process.env, "--mcp-cwd", "MCP_CWD") ?? process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd());
    const server = serveMcp({ analysis, ttlSeconds: ttl });
    const close = (): void => server.close();
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, close);
    await server.closed;
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, close);
    // Node deliberately makes process.stdout.destroy() a no-op. After the
    // server's bounded drain/worker abort, exit releases any blocked fd writes.
    process.exit(process.exitCode ?? 0);
  }
}
