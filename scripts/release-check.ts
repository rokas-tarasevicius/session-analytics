#!/usr/bin/env node
/** Release preflight: source checks, then the compiled package is built, packed, installed and run. Reads synthetic data only; never publishes or changes repository settings. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateSnapshot } from "../src/interop/snapshot.ts";
import { staticRoutes } from "../src/static-routes.ts";
import { version } from "../src/version.ts";

interface ReleaseMetadata {
  packageVersion: string;
  lockVersion: string;
  lockRootVersion: string;
  sourceVersion: string;
  changelog: string;
}

const repositoryUrl = "https://github.com/rokas-tarasevicius/session-analytics";

/** Fail before publishing when a tag names different code, or the changelog describes or links an older release. */
export function checkReleaseMetadata(metadata: ReleaseMetadata, tag?: string): void {
  const expected = metadata.sourceVersion;
  if (!/^\d+\.\d+\.\d+$/.test(expected)) throw new Error("Source version must be a stable X.Y.Z version.");
  for (const [name, value] of Object.entries({ package: metadata.packageVersion, lockfile: metadata.lockVersion, lockRoot: metadata.lockRootVersion })) {
    if (value !== expected) throw new Error(`${name} version does not match source version ${expected}.`);
  }
  const latest = /^## \[(\d+\.\d+\.\d+)\](?:\s|$)/m.exec(metadata.changelog)?.[1];
  if (latest !== expected) throw new Error(`Latest changelog release does not match source version ${expected}.`);
  const links = metadata.changelog.split(/\r?\n/);
  if (!links.includes(`[Unreleased]: ${repositoryUrl}/compare/v${expected}...HEAD`)) throw new Error(`Changelog must link [Unreleased] to ${repositoryUrl}/compare/v${expected}...HEAD.`);
  if (!links.some((line) => line.startsWith(`[${expected}]: ${repositoryUrl}/`) && line.endsWith(`v${expected}`))) throw new Error(`Changelog must link [${expected}] to its changes, ending at v${expected}.`);
  if (tag !== undefined && tag !== `v${expected}`) throw new Error(`Release tag must be v${expected}.`);
}

export function extractReleaseNotes(metadata: ReleaseMetadata, tag: string): string {
  checkReleaseMetadata(metadata, tag);
  const heading = `## [${metadata.sourceVersion}]`;
  const lines = metadata.changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line === heading || line.startsWith(`${heading} - `));
  if (start < 0) throw new Error(`Missing changelog section for ${tag}.`);
  const end = lines.findIndex((line, index) => index > start && (line.startsWith("## ") || /^\[[^\]]+\]: /.test(line)));
  const notes = lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
  if (!notes || !notes.split("\n").some((line) => line.trim() && !line.startsWith("#"))) {
    throw new Error(`Changelog section for ${tag} has no release notes.`);
  }
  return `${notes}\n`;
}

/** The compiled package must carry every entry point, worker, served file, notice and schema, and no source, map or local data. */
export function checkPackageFiles(paths: string[]): void {
  const required = [
    "package.json", "README.md", "LICENSE", "CHANGELOG.md",
    "bin/session-analytics.js", "src/analysis-worker.js", "src/cursor-worker.js", "src/mcp/worker.js", "src/server.js", "src/remote/bootstrap.js", "src/remote/runtime.js",
    ...staticRoutes.map(([, file]) => `src/public/${file}`),
    "src/public/fonts/OFL-1.1.txt", "src/public/brands/NOTICE.md",
    "data/rate-cards.json", "schemas/snapshot.v1.schema.json", "schemas/shared.v1.schema.json",
    "skills/session-analytics/SKILL.md",
  ];
  for (const path of required) if (!paths.includes(path)) throw new Error(`Package is missing ${path}.`);
  for (const path of paths) {
    const parts = path.split("/");
    const allowed = /^(?:bin|src|data|schemas|skills)\//.test(path) || /^(?:package\.json|README\.md|LICENSE|CHANGELOG\.md)$/.test(path);
    if (!allowed || parts.some((part) => part.startsWith(".") || part === "node_modules") ||
        /\.(?:ts|mts|cts|map|tsbuildinfo|log|sqlite|db|jsonl|tgz|pem|key)$/i.test(path)) {
      throw new Error(`Unexpected package file: ${path}.`);
    }
  }
}

/** Installing must run nothing, and the installed command must be this version's compiled bin. */
export function checkPackageManifest(manifest: Record<string, unknown>, binSource: string, expectedVersion: string): void {
  for (const field of ["scripts", "dependencies", "optionalDependencies", "peerDependencies", "bundleDependencies", "bundledDependencies", "devDependencies", "private", "publishConfig"]) {
    if (manifest[field] !== undefined) throw new Error(`Package manifest must not declare ${field}.`);
  }
  if (manifest["name"] !== "session-analytics" || manifest["type"] !== "module") throw new Error("Package manifest must be the session-analytics ES module package.");
  if (manifest["version"] !== expectedVersion) throw new Error(`Package version does not match source version ${expectedVersion}.`);
  if (JSON.stringify(manifest["bin"]) !== JSON.stringify({ "session-analytics": "bin/session-analytics.js" })) throw new Error("Package bin must be bin/session-analytics.js.");
  if (!binSource.startsWith("#!/usr/bin/env node\n")) throw new Error("Package bin must start with #!/usr/bin/env node.");
  const engines = manifest["engines"] as { node?: unknown } | undefined, os = manifest["os"];
  if (engines?.node !== ">=24" || !Array.isArray(os) || !os.includes("darwin") || !os.includes("linux")) throw new Error("Package manifest must require Node.js 24 on macOS and Linux.");
}

function main(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const lockfile = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8"));
  const metadata: ReleaseMetadata = {
    packageVersion: manifest.version, lockVersion: lockfile.version,
    lockRootVersion: lockfile.packages?.[""]?.version, sourceVersion: version,
    changelog: readFileSync(resolve(root, "CHANGELOG.md"), "utf8"),
  };
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === "--notes") {
    writeFileSync("notes.md", extractReleaseNotes(metadata, args[1]!));
    console.log(`Release tag and notes verified: ${args[1]}`);
    return;
  }
  // --port fixes the installed smoke's dashboard port; it otherwise takes any free one.
  const smokePort = args.length === 2 && args[0] === "--port" ? args[1]! : null;
  if (args.length && !smokePort) throw new Error("Usage: node scripts/release-check.ts [--notes vX.Y.Z | --port PORT]");
  checkReleaseMetadata(metadata);
  extractReleaseNotes(metadata, `v${version}`);
  if (Object.keys(manifest.dependencies ?? {}).length || Object.keys(manifest.optionalDependencies ?? {}).length) {
    throw new Error("Source release must have zero runtime dependencies.");
  }
  console.log(`Release metadata agrees at ${version}.`);

  function run(command: string, arguments_: string[]): string {
    const result = spawnSync(command, arguments_, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 120_000 });
    if (result.error || result.status !== 0) {
      if (result.stderr) process.stderr.write(result.stderr);
      throw new Error(`Release check failed: ${command} ${arguments_.join(" ")}`);
    }
    return result.stdout;
  }
  run(process.execPath, ["scripts/snapshot-schema.ts", "--check"]);
  console.log("Published snapshot schemas match the source.");
  // --bin names the checkout even when SESSION_ANALYTICS_DEMO_BIN points the demo at another build.
  const json = run(process.execPath, ["scripts/demo.ts", "report", "--json", "--bin", join(root, "bin/session-analytics.ts")]);
  const snapshot = validateSnapshot(JSON.parse(json));
  if (snapshot.sessions.length === 0 || new Set(snapshot.sessions.map((session) => session.provider)).size !== 6) {
    throw new Error("Synthetic report must include sessions from all six providers.");
  }
  if (/PRIVATE_DEMO_CONTENT_SENTINEL|synthetic demo prompt|synthetic demo response|synthetic tool result|synthetic-demo-only|session-analytics-demo-|\/repos\/|\/projects\//.test(json)) {
    throw new Error("Synthetic report contains private fixture content.");
  }
  console.log(`Synthetic report passes the snapshot contract (${snapshot.sessions.length} sessions, six providers).`);
  run(process.execPath, ["scripts/build.ts"]);
  const destination = mkdtempSync(join(tmpdir(), "session-analytics-pack-"));
  try {
    const packed = JSON.parse(run("npm", ["pack", "./dist", "--json", "--ignore-scripts", "--pack-destination", destination]));
    if (!Array.isArray(packed) || packed.length !== 1 || !Array.isArray(packed[0]?.files) || typeof packed[0]?.filename !== "string") throw new Error("Unexpected npm package manifest.");
    checkPackageFiles(packed[0].files.map((entry: { path: string }) => entry.path));
    checkPackageManifest(JSON.parse(readFileSync(resolve(root, "dist/package.json"), "utf8")), readFileSync(resolve(root, "dist/bin/session-analytics.js"), "utf8"), version);
    console.log(`Compiled package files and manifest pass (${packed[0].files.length} files, ${packed[0].size} bytes packed).`);
    const smoke = spawnSync(process.execPath, ["scripts/smoke-installed.ts", join(destination, packed[0].filename), ...(smokePort ? ["--port", smokePort] : [])], { cwd: root, stdio: "inherit", timeout: 900_000 });
    if (smoke.error || smoke.status !== 0) throw new Error("Release check failed: the installed package smoke test.");
  } finally { rmSync(destination, { recursive: true, force: true }); }
  console.log("Release preflight passed. No package or release was published; hosted CI and repository settings remain separate gates.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Release check failed."}\n`);
    process.exitCode = 1;
  }
}
