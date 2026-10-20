#!/usr/bin/env node
/**
 * Prepare the next release from the Conventional Commit titles merged since the last release tag: `feat` is a minor version,
 * `fix` and `perf` a patch, and a breaking change (`type!:` or a `BREAKING CHANGE:` footer) a major one, or a minor one while the
 * version is 0.x. Other types (docs, test, ci, chore, refactor, …) release nothing. With --write it sets the version in
 * package.json, package-lock.json and src/version.ts, moves the changelog's Unreleased notes (or, when there are none, notes
 * generated from the titles) into the new version's section, and on a new minor or major version updates SECURITY.md.
 * Reads git history only; never commits, tags or publishes.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Bump = "major" | "minor" | "patch";
export interface Commit { subject: string; body: string }
interface Parsed { type: string; breaking: boolean; description: string }

const repositoryUrl = "https://github.com/rokas-tarasevicius/session-analytics";
const order: Bump[] = ["patch", "minor", "major"];

/** A Conventional Commit title, or null for a title that is not one. */
export function parseCommit({ subject, body }: Commit): Parsed | null {
  const match = /^(\w+)(?:\([^)]*\))?(!)?: (.+)$/.exec(subject.trim());
  if (!match) return null;
  return { type: match[1]!.toLowerCase(), breaking: Boolean(match[2]) || /^BREAKING[ -]CHANGE: /m.test(body), description: match[3]! };
}

/** The bump a commit asks for, if any. */
export function bumpOf(commit: Commit): Bump | null {
  const parsed = parseCommit(commit);
  if (!parsed) return null;
  if (parsed.breaking) return "major";
  if (parsed.type === "feat") return "minor";
  if (parsed.type === "fix" || parsed.type === "perf") return "patch";
  return null;
}

/** The next version after `current` for these commits, or null when none of them releases anything. */
export function nextVersion(current: string, commits: Commit[]): { version: string, bump: Bump } | null {
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(current)?.slice(1).map(Number);
  if (!parts) throw new Error(`Current version must be a stable X.Y.Z version, not ${current}.`);
  const bumps = commits.map(bumpOf).filter((bump): bump is Bump => bump !== null);
  if (!bumps.length) return null;
  let bump = bumps.reduce((highest, next) => order.indexOf(next) > order.indexOf(highest) ? next : highest);
  // Before 1.0.0 a breaking change is a minor version, as Semantic Versioning allows for initial development.
  if (bump === "major" && parts[0] === 0) bump = "minor";
  const [major, minor, patch] = parts as [number, number, number];
  const version = bump === "major" ? `${major + 1}.0.0` : bump === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
  return { version, bump };
}

/** Changelog notes generated from the titles, for a release whose Unreleased section is empty. */
export function generatedNotes(commits: Commit[]): string {
  const sections: Array<[string, (parsed: Parsed) => boolean]> = [
    ["Changed", (parsed) => parsed.breaking], ["Added", (parsed) => !parsed.breaking && parsed.type === "feat"], ["Fixed", (parsed) => !parsed.breaking && (parsed.type === "fix" || parsed.type === "perf")],
  ];
  const parsed = commits.map(parseCommit).filter((commit): commit is Parsed => commit !== null);
  return sections.map(([heading, matches]) => {
    const entries = parsed.filter(matches).map((commit) => `- ${commit.description[0]!.toUpperCase()}${commit.description.slice(1)}`);
    return entries.length ? `### ${heading}\n\n${entries.join("\n")}\n` : "";
  }).filter(Boolean).join("\n");
}

/** The changelog with Unreleased moved into `version`'s section, dated `date`, and its compare links updated. */
export function releaseChangelog(changelog: string, previous: string, version: string, date: string, commits: Commit[]): string {
  const heading = /^## \[Unreleased\]\n/m.exec(changelog);
  if (!heading) throw new Error("CHANGELOG.md has no ## [Unreleased] section.");
  const start = heading.index + heading[0].length;
  const end = changelog.slice(start).search(/^## \[/m);
  if (end < 0) throw new Error("CHANGELOG.md has no released version after Unreleased.");
  const unreleased = changelog.slice(start, start + end).trim();
  const hasNotes = unreleased.split("\n").some((line) => line.trim() && !line.startsWith("#"));
  const notes = hasNotes ? unreleased : generatedNotes(commits).trim();
  if (!notes) throw new Error("There are no release notes to write.");
  let next = `${changelog.slice(0, start)}\n## [${version}] - ${date}\n\n${notes}\n\n${changelog.slice(start + end)}`;
  const unreleasedLink = `[Unreleased]: ${repositoryUrl}/compare/v${previous}...HEAD\n`;
  if (!next.includes(unreleasedLink)) throw new Error(`CHANGELOG.md's [Unreleased] link does not compare v${previous}...HEAD.`);
  next = next.replace(unreleasedLink, `[Unreleased]: ${repositoryUrl}/compare/v${version}...HEAD\n[${version}]: ${repositoryUrl}/compare/v${previous}...v${version}\n`);
  return next;
}

/** SECURITY.md's supported-versions table for a new minor or major version; unchanged for a patch. */
export function releaseSecurityPolicy(policy: string, version: string): string {
  const [major, minor] = version.split(".");
  return policy.replace(/^\| \d+\.\d+\.x \| Yes \|$/m, `| ${major}.${minor}.x | Yes |`).replace(/^\| Earlier than \d+\.\d+\.0 \| No \|$/m, `| Earlier than ${major}.${minor}.0 | No |`);
}

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

function main(argv: string[]): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const write = argv.includes("--write");
  const output = argv.includes("--output") ? argv[argv.indexOf("--output") + 1] : undefined;
  const date = argv.includes("--date") ? argv[argv.indexOf("--date") + 1]! : new Date().toISOString().slice(0, 10);
  const report = (fields: Record<string, string>) => {
    if (output) appendFileSync(output, Object.entries(fields).map(([key, value]) => `${key}=${value}\n`).join(""));
  };

  const read = (path: string) => readFileSync(join(root, path), "utf8");
  const current = JSON.parse(read("package.json")).version as string;
  const tags = git(root, "tag", "--list", "v[0-9]*.[0-9]*.[0-9]*", "--merged", "HEAD").split("\n").filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
  if (!tags.includes(`v${current}`)) {
    console.log(`v${current} is not released yet; the release workflow publishes it, so there is nothing to prepare.`);
    return report({ version: "" });
  }
  const commits = git(root, "log", "--format=%s%x1f%b%x1e", `v${current}..HEAD`).split("\x1e").map((record) => record.trim()).filter(Boolean)
    .map((record) => { const [subject, body = ""] = record.split("\x1f"); return { subject: subject!, body }; });
  const next = nextVersion(current, commits);
  if (!next) {
    console.log(`Nothing to release: the ${commits.length} commit(s) since v${current} are not features, fixes or breaking changes.`);
    return report({ version: "" });
  }
  console.log(`Next release: ${next.version} (${next.bump}) from ${commits.length} commit(s) since v${current}.`);
  if (write) {
    const changelog = releaseChangelog(read("CHANGELOG.md"), current, next.version, date, commits);
    const manifest = JSON.parse(read("package.json")), lock = JSON.parse(read("package-lock.json"));
    manifest.version = next.version;
    lock.version = next.version;
    lock.packages[""].version = next.version;
    writeFileSync(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(root, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
    writeFileSync(join(root, "src/version.ts"), read("src/version.ts").replace(/version = "[^"]*"/, `version = "${next.version}"`));
    writeFileSync(join(root, "CHANGELOG.md"), changelog);
    if (next.bump !== "patch") writeFileSync(join(root, "SECURITY.md"), releaseSecurityPolicy(read("SECURITY.md"), next.version));
  }
  report({ version: next.version, bump: next.bump, previous: current });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
