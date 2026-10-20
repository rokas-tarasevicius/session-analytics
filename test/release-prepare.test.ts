// The release pull request: the next version from Conventional Commit titles, and the files a release changes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bumpOf, generatedNotes, nextVersion, releaseChangelog, releaseSecurityPolicy, type Commit } from "../scripts/release-prepare.ts";

const commit = (subject: string, body = ""): Commit => ({ subject, body });
const repository = "https://github.com/rokas-tarasevicius/session-analytics";

test("release PR: feat is minor, fix and perf a patch, breaking a major or, before 1.0.0, a minor; anything else releases nothing", () => {
  for (const [subject, body, bump] of [
    ["feat(cli): upgrade (#81)", "", "minor"], ["feat: Subscription view (#64)", "", "minor"], ["fix(dashboard): poll a long scan (#82)", "", "patch"], ["perf: faster scans", "", "patch"],
    ["feat(cli)!: drop --remote", "", "major"], ["fix: rename a field", "Body.\n\nBREAKING CHANGE: report.json drops `x`.", "major"], ["refactor!: new index", "", "major"],
    ["docs: README", "", null], ["test(browser): wait for Chrome", "", null], ["ci(release): dry run", "", null], ["chore(release): 0.10.1 (#77)", "", null],
    ["Restyle the dashboard and docs with Fluxary (#60)", "", null], ["v0.8.1 chore: prepare", "", null], ["fix:no space", "", null],
  ] as const) assert.equal(bumpOf(commit(subject, body)), bump, subject);

  assert.equal(nextVersion("0.10.3", [commit("docs: a"), commit("ci: b")]), null, "nothing releasable");
  assert.equal(nextVersion("0.10.3", []), null);
  assert.deepEqual(nextVersion("0.10.3", [commit("fix: a"), commit("docs: b")]), { version: "0.10.4", bump: "patch" });
  assert.deepEqual(nextVersion("0.10.3", [commit("fix: a"), commit("feat: b"), commit("fix: c")]), { version: "0.11.0", bump: "minor" });
  assert.deepEqual(nextVersion("0.10.3", [commit("feat!: a")]), { version: "0.11.0", bump: "minor" }, "0.x: breaking is a minor version");
  assert.deepEqual(nextVersion("1.4.2", [commit("fix: a"), commit("feat!: b")]), { version: "2.0.0", bump: "major" });
  assert.deepEqual(nextVersion("1.4.2", [commit("feat: a")]), { version: "1.5.0", bump: "minor" });
  for (const version of ["1.2", "1.2.3-rc.1", "v1.2.3"]) assert.throws(() => nextVersion(version, [commit("fix: a")]), /stable X\.Y\.Z/, version);
});

test("release PR: Unreleased notes move under the new version with its compare link; without notes, the titles become them", () => {
  const changelog = (unreleased: string) => `# Changelog\n\n## [Unreleased]\n${unreleased}\n## [0.10.3] - 2026-10-20\n\n### Fixed\n\n- Old.\n\n`
    + `[Unreleased]: ${repository}/compare/v0.10.3...HEAD\n[0.10.3]: ${repository}/compare/v0.10.2...v0.10.3\n`;
  const commits = [commit("feat(cli): session-analytics upgrade (#81)"), commit("fix(dashboard): poll a long scan (#82)"), commit("docs: typo"), commit("feat!: drop a flag")];

  const written = releaseChangelog(changelog("\n### Added\n\n- Hand-written note.\n"), "0.10.3", "0.11.0", "2026-10-21", commits);
  assert.equal(written, `# Changelog\n\n## [Unreleased]\n\n## [0.11.0] - 2026-10-21\n\n### Added\n\n- Hand-written note.\n\n## [0.10.3] - 2026-10-20\n\n### Fixed\n\n- Old.\n\n`
    + `[Unreleased]: ${repository}/compare/v0.11.0...HEAD\n[0.11.0]: ${repository}/compare/v0.10.3...v0.11.0\n[0.10.3]: ${repository}/compare/v0.10.2...v0.10.3\n`);

  const generated = releaseChangelog(changelog("\n"), "0.10.3", "0.11.0", "2026-10-21", commits);
  assert.match(generated, /## \[Unreleased\]\n\n## \[0\.11\.0\] - 2026-10-21\n\n### Changed\n\n- Drop a flag\n\n### Added\n\n- Session-analytics upgrade \(#81\)\n\n### Fixed\n\n- Poll a long scan \(#82\)\n\n## \[0\.10\.3\]/);
  assert.equal(generatedNotes([commit("docs: a")]), "");

  assert.throws(() => releaseChangelog(changelog("\n"), "0.10.3", "0.10.4", "2026-10-21", [commit("docs: a")]), /no release notes/);
  assert.throws(() => releaseChangelog(changelog("\n- x\n"), "0.10.2", "0.10.4", "2026-10-21", commits), /\[Unreleased\] link/);
  assert.throws(() => releaseChangelog("# Changelog\n", "0.10.3", "0.10.4", "2026-10-21", commits), /no ## \[Unreleased\]/);
});

test("release PR: a new minor version moves SECURITY.md's supported versions", () => {
  const policy = "| Version | Supported |\n| --- | --- |\n| 0.10.x | Yes |\n| Earlier than 0.10.0 | No |\n";
  assert.equal(releaseSecurityPolicy(policy, "0.11.0"), "| Version | Supported |\n| --- | --- |\n| 0.11.x | Yes |\n| Earlier than 0.11.0 | No |\n");
  assert.equal(releaseSecurityPolicy(policy, "1.0.0"), "| Version | Supported |\n| --- | --- |\n| 1.0.x | Yes |\n| Earlier than 1.0.0 | No |\n");
});

test("release PR: the script prepares a release from a repository's tags and history, and nothing while the current version is unreleased", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const scratch = await mkdtemp(join(tmpdir(), "session-analytics-release-pr-")), work = join(scratch, "repo");
  try {
    await mkdir(join(work, "scripts"), { recursive: true });
    await mkdir(join(work, "src"));
    for (const path of ["scripts/release-prepare.ts", "package.json", "package-lock.json", "src/version.ts", "CHANGELOG.md", "SECURITY.md"]) await cp(join(root, path), join(work, path), { recursive: true });
    const env = { PATH: process.env["PATH"], HOME: work, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "M", GIT_AUTHOR_EMAIL: "m@example.com", GIT_COMMITTER_NAME: "M", GIT_COMMITTER_EMAIL: "m@example.com" };
    const git = (...args: string[]) => { const result = spawnSync("git", args, { cwd: work, encoding: "utf8", env }); assert.equal(result.status, 0, result.stderr); return result.stdout; };
    const prepare = async (...args: string[]) => {
      const output = join(scratch, "output");
      await rm(output, { force: true });
      const result = spawnSync(process.execPath, ["scripts/release-prepare.ts", "--output", output, "--date", "2026-10-21", ...args], { cwd: work, encoding: "utf8", env });
      assert.equal(result.status, 0, result.stderr);
      return { stdout: result.stdout, output: await readFile(output, "utf8") };
    };
    const current = JSON.parse(await readFile(join(work, "package.json"), "utf8")).version as string;
    git("init", "--quiet", "--initial-branch", "master");
    git("add", ".");
    git("commit", "--quiet", "-m", `chore(release): ${current}`);

    assert.match((await prepare()).output, /^version=\n$/, "an untagged version is still being released");
    git("tag", `v${current}`);
    assert.match((await prepare()).stdout, /Nothing to release: the 0 commit/);
    git("commit", "--quiet", "--allow-empty", "-m", "docs: a typo");
    assert.equal((await prepare()).output, "version=\n");
    git("commit", "--quiet", "--allow-empty", "-m", "fix(dashboard): a fix (#1)");
    const [major, minor, patch] = current.split(".").map(Number) as [number, number, number];
    assert.equal((await prepare()).output, `version=${major}.${minor}.${patch + 1}\nbump=patch\nprevious=${current}\n`);
    assert.equal(git("status", "--porcelain"), "", "without --write nothing changes");

    git("commit", "--quiet", "--allow-empty", "-m", "feat(cli): a feature (#2)");
    const next = `${major}.${minor + 1}.0`;
    assert.equal((await prepare("--write")).output, `version=${next}\nbump=minor\nprevious=${current}\n`);
    assert.equal(JSON.parse(await readFile(join(work, "package.json"), "utf8")).version, next);
    const lock = JSON.parse(await readFile(join(work, "package-lock.json"), "utf8"));
    assert.deepEqual([lock.version, lock.packages[""].version], [next, next]);
    assert.match(await readFile(join(work, "src/version.ts"), "utf8"), new RegExp(`version = "${next.replaceAll(".", "\\.")}"`));
    assert.match(await readFile(join(work, "CHANGELOG.md"), "utf8"), new RegExp(`## \\[Unreleased\\]\\n\\n## \\[${next.replaceAll(".", "\\.")}\\] - 2026-10-21\\n`));
    assert.match(await readFile(join(work, "SECURITY.md"), "utf8"), new RegExp(`\\| ${major}\\.${minor + 1}\\.x \\| Yes \\|`));
    assert.deepEqual(git("status", "--porcelain").split("\n").filter(Boolean).map((line) => line.slice(3)).sort(), ["CHANGELOG.md", "SECURITY.md", "package-lock.json", "package.json", "src/version.ts"]);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("release PR: the workflow runs on merges to master with write access in its one job, and gets CI to run on the release branch", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release-pr.yml", import.meta.url), "utf8");
  assert.match(workflow, /\non:\n(?: {2}#.*\n)*  push:\n    branches: \[master\]\n  workflow_dispatch:\n/);
  assert.match(workflow, /\npermissions:\n  contents: read\n/);
  assert.match(workflow, /\n    permissions:\n      contents: write\n      pull-requests: write\n      actions: write\n/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /secrets\.|pull_request_target/, "no secret");
  for (const line of workflow.split("\n").filter((line) => line.includes("${{ steps."))) assert.match(line, /^ {8}if: |^ {10}[A-Z_]+: \$\{\{ steps\./, `step outputs reach scripts only through env: ${line}`);
  assert.match(workflow, /node scripts\/release-prepare\.ts --write --output "\$GITHUB_OUTPUT"/);
  assert.match(workflow, /HEAD:refs\/heads\/release\/next/);
  assert.match(workflow, /--title "chore\(release\): \$V"/);
  assert.match(workflow, /actions\/runs\/\$RUN\/approve/, "the release pull request's own CI run is approved");
  assert.match(workflow, /gh workflow run ci\.yml --ref release\/next/, "or, failing that, CI is dispatched on the branch");
  const ci = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(ci, /\n  workflow_dispatch:\n/, "CI can be dispatched on the release branch");
});
