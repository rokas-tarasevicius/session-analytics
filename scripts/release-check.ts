#!/usr/bin/env node
/** Source-release preflight. Reads synthetic data only; never publishes or changes repository settings. */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateSnapshot } from "../src/interop/snapshot.ts";
import { version } from "../src/version.ts";

interface ReleaseMetadata {
  packageVersion: string;
  lockVersion: string;
  lockRootVersion: string;
  sourceVersion: string;
  changelog: string;
}

/** Fail before publishing when a tag names different code, or the changelog describes an older release. */
export function checkReleaseMetadata(metadata: ReleaseMetadata, tag?: string): void {
  const expected = metadata.sourceVersion;
  if (!/^\d+\.\d+\.\d+$/.test(expected)) throw new Error("Source version must be a stable X.Y.Z version.");
  for (const [name, value] of Object.entries({ package: metadata.packageVersion, lockfile: metadata.lockVersion, lockRoot: metadata.lockRootVersion })) {
    if (value !== expected) throw new Error(`${name} version does not match source version ${expected}.`);
  }
  const latest = /^## \[(\d+\.\d+\.\d+)\](?:\s|$)/m.exec(metadata.changelog)?.[1];
  if (latest !== expected) throw new Error(`Latest changelog release does not match source version ${expected}.`);
  if (tag !== undefined && tag !== `v${expected}`) throw new Error(`Release tag must be v${expected}.`);
}

export function extractReleaseNotes(metadata: ReleaseMetadata, tag: string): string {
  checkReleaseMetadata(metadata, tag);
  const heading = `## [${metadata.sourceVersion}]`;
  const lines = metadata.changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line === heading || line.startsWith(`${heading} - `));
  if (start < 0) throw new Error(`Missing changelog section for ${tag}.`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  const notes = lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
  if (!notes || !notes.split("\n").some((line) => line.trim() && !line.startsWith("#"))) {
    throw new Error(`Changelog section for ${tag} has no release notes.`);
  }
  return `${notes}\n`;
}

export function checkPackageFiles(paths: string[]): void {
  const required = [
    "package.json", "README.md", "LICENSE", "CHANGELOG.md",
    "bin/session-analytics.ts", "src/analysis-worker.ts", "src/cursor-worker.ts", "src/server.ts",
    "src/public/index.html", "src/public/app.js", "src/public/styles.css",
    "src/public/fonts/geist-latin.woff2", "src/public/fonts/geist-mono-latin.woff2",
    "src/public/fonts/OFL-1.1.txt", "src/public/brands/NOTICE.md",
    "data/rate-cards.json", "schemas/snapshot.v1.schema.json", "schemas/shared.v1.schema.json",
    "skills/session-analytics/SKILL.md",
  ];
  for (const path of required) if (!paths.includes(path)) throw new Error(`Package is missing ${path}.`);
  for (const path of paths) {
    const parts = path.split("/");
    const allowed = /^(?:bin|src|data|schemas|skills)\//.test(path) || /^(?:package\.json|README\.md|LICENSE|CHANGELOG\.md)$/.test(path);
    if (!allowed || parts.some((part) => part.startsWith(".") || part === "node_modules") || /\.(?:log|sqlite|db|jsonl|tgz|pem|key)$/i.test(path)) {
      throw new Error(`Unexpected package file: ${path}.`);
    }
  }
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
  if (args.length) throw new Error("Usage: node scripts/release-check.ts [--notes vX.Y.Z]");
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
  const json = run(process.execPath, ["scripts/demo.ts", "report", "--json"]);
  const snapshot = validateSnapshot(JSON.parse(json));
  if (snapshot.sessions.length === 0 || new Set(snapshot.sessions.map((session) => session.provider)).size !== 6) {
    throw new Error("Synthetic report must include sessions from all six providers.");
  }
  if (/PRIVATE_DEMO_CONTENT_SENTINEL|synthetic demo prompt|synthetic demo response|synthetic tool result|synthetic-demo-only|session-analytics-demo-|\/repos\/|\/projects\//.test(json)) {
    throw new Error("Synthetic report contains private fixture content.");
  }
  console.log(`Synthetic report passes the snapshot contract (${snapshot.sessions.length} sessions, six providers).`);
  const packed = JSON.parse(run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"]));
  if (!Array.isArray(packed) || packed.length !== 1 || !Array.isArray(packed[0]?.files)) throw new Error("Unexpected npm package manifest.");
  checkPackageFiles(packed[0].files.map((entry: { path: string }) => entry.path));
  console.log(`Package allowlist and required assets pass (${packed[0].files.length} files).`);
  console.log("Source preflight passed. No package or release was published; hosted CI and repository settings remain separate gates.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Release check failed."}\n`);
    process.exitCode = 1;
  }
}
