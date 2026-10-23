import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { validateSnapshot } from "../src/interop/snapshot.ts";
import { Element, Option, documentFromHtml } from "./release-dom.ts";
import { version } from "../src/version.ts";
import { checkPackageFiles, checkPackageManifest, checkReleaseMetadata, extractReleaseNotes } from "../scripts/release-check.ts";
import { build } from "../scripts/build.ts";
import { homebrewFormula } from "../scripts/homebrew-formula.ts";
import { staticRoutes } from "../src/static-routes.ts";

const views = ["summary", "velocity", "costs", "pricing", "subscription", "tools", "activity"];
const forbidden = /PRIVATE_DEMO_CONTENT_SENTINEL|synthetic demo prompt|synthetic demo response|synthetic tool result|synthetic-demo-only|session-analytics-demo-|\/repos\/|\/projects\//;

test("release: package, lockfile, CLI and latest changelog versions agree", async () => {
  const [manifest, lockfile, changelog] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
    readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8"),
  ]);
  const latest = /^## \[(\d+\.\d+\.\d+)\](?:\s|$)/m.exec(changelog);
  assert.ok(latest, "CHANGELOG.md must have a released version heading");
  assert.equal(JSON.parse(manifest).version, version, "package.json matches src/version.ts");
  assert.equal(JSON.parse(lockfile).version, version, "package-lock.json matches src/version.ts");
  assert.equal(latest[1], version, "latest CHANGELOG.md release matches src/version.ts");
});

test("release: every CI event uses hosted Linux and macOS with required browser checks", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const [check, browser] = workflow.split("\n  browser:\n");
  assert.ok(check && browser);
  const matrix = /^        os: \[([^\]]+)\]$/m.exec(check)?.[1];
  assert.ok(matrix, "all events share a fixed hosted runner matrix");
  assert.deepEqual(matrix.split(",").map((runner) => runner.trim()), ["ubuntu-latest", "macos-latest"]);
  assert.match(check, /name: check \(\$\{\{ matrix.os \}\}\)/);
  assert.match(workflow, /on:\n  push:\n    branches: \[master\]\n  pull_request:\n  workflow_dispatch:/);
  assert.doesNotMatch(workflow, /agentbox|self-hosted|repository\.private|continue-on-error/);
  assert.doesNotMatch(check, /^    if:/m, "platform checks cannot skip any supported event");
  assert.match(check, /permissions:\n  contents: read/);
  assert.match(check, /concurrency:\n  group: ci-.*\n  cancel-in-progress: true/);
  assert.match(check, /run: npm run release:check/);
  assert.match(browser, /name: browser \(ubuntu-latest\)/);
  assert.match(browser, /runs-on: ubuntu-latest/);
  assert.doesNotMatch(browser, /^    if:/m, "browser checks cannot skip private repositories or pull requests");
  assert.match(browser, /SESSION_ANALYTICS_REQUIRE_BROWSER: '1'/);
  assert.match(browser, /run: npm run test:browser/);
  assert.match(browser, /SESSION_ANALYTICS_CHROME: \/usr\/bin\/google-chrome/);
  for (const job of [check, browser]) {
    assert.match(job, /persist-credentials: false/);
    assert.match(job, /node-version: 24/);
    assert.match(job, /run: npm ci/);
  }
  assert.doesNotMatch(workflow, /pull_request_target/);
});

/** Split a workflow into its jobs by two-space-indented keys; the workflows are plain, so no YAML parser is needed. */
function workflowJobs(workflow: string): Record<string, string> {
  const body = workflow.split("\njobs:\n")[1];
  assert.ok(body, "workflow has jobs");
  return Object.fromEntries(body.split(/^(?=  [a-z][a-z-]*:\n)/m).map((job) => [/^  ([a-z][a-z-]*):/.exec(job)![1]!, job]));
}
const needsOf = (job: string): string[] => {
  const needs = /^    needs: (?:\[([^\]]*)\]|(\S+))$/m.exec(job);
  return needs ? (needs[1] ?? needs[2]!).split(",").map((name) => name.trim()) : [];
};
const permissionsOf = (job: string): string[] => /^    permissions:\n((?: {6}\S.*\n)+)/m.exec(job)?.[1]!.trim().split(/\n\s*/) ?? [];
/** The plan job's outputs: the release tag, whether to run the checks, and whether to publish. */
type Plan = { tag: string, check: string, publish: string };
const releasing: Plan = { tag: "v1.2.3", check: "true", publish: "true" };
/** Evaluate a job's `if:` as GitHub would for given results; the gates use only ==, &&, ||, !, cancelled(), contains() and startsWith(). */
type GateContext = { needs: Record<string, string>, plan?: Plan, vars?: Record<string, string>, event?: string, ref?: string, cancelled?: boolean };
function gate(job: string): (context: GateContext) => boolean {
  const expression = /^    if: \$\{\{ (.*) \}\}$/m.exec(job)?.[1];
  assert.ok(expression, "gated jobs state their gate");
  const evaluate = new Function("needs", "vars", "github", "cancelled", "contains", "startsWith", `return ${expression};`);
  return ({ needs, plan = releasing, vars = {}, event = "push", ref = "refs/heads/master", cancelled = false }) => evaluate(
    { ...Object.fromEntries(Object.entries(needs).map(([name, result]) => [name, { result }])), plan: { result: "success", ...needs["plan"] === undefined ? {} : { result: needs["plan"] }, outputs: plan } }, vars,
    { event_name: event, ref, ref_name: ref.replace(/^refs\/(?:heads|tags)\//, "") }, () => cancelled,
    (text: string, part: string) => text.includes(part), (text: string, prefix: string) => text.startsWith(prefix));
}
const results = ["success", "failure", "skipped", "cancelled"];
/** github.com's SSH host key fingerprints as GitHub publishes them (`gh api meta --jq .ssh_key_fingerprints`). */
const githubHostKeys = [
  "ssh-ed25519 SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU",
  "ecdsa-sha2-nistp256 SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM",
  "ssh-rsa SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s",
];
/** Each known_hosts line's key type and SHA-256 fingerprint, computed as `ssh-keygen -l` does. */
const hostKeyFingerprints = (knownHosts: string): string[] => knownHosts.trim().split("\n").map((line) => {
  const [host, type, key, ...rest] = line.split(" ");
  assert.equal(host, "github.com", line);
  assert.deepEqual(rest, [], line);
  return `${type} SHA256:${createHash("sha256").update(Buffer.from(key!, "base64")).digest("base64").replace(/=+$/, "")}`;
});
/** Runs that never publish: a manual dry run on a branch or a tag, a push elsewhere than master, and a push to master that changed no version. */
const untagged: Array<Omit<GateContext, "needs">> = [
  { event: "workflow_dispatch", ref: "refs/heads/master", plan: { tag: "v1.2.3", check: "true", publish: "false" } },
  { event: "workflow_dispatch", ref: "refs/tags/v1.2.3", plan: { tag: "v1.2.3", check: "true", publish: "false" } },
  { event: "push", ref: "refs/heads/fix/a-branch", plan: releasing },
  { event: "push", ref: "refs/tags/v1.2.3", plan: releasing },
  { event: "push", ref: "refs/heads/master", plan: { tag: "v1.2.3", check: "false", publish: "false" } },
];

test("release: every workflow action is pinned to a full commit SHA", async () => {
  for (const name of ["ci.yml", "release.yml", "release-pr.yml"]) {
    const workflow = await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");
    const uses = [...workflow.matchAll(/^\s+(?:- )?uses: (.+)$/gm)].map((match) => match[1]!);
    assert.ok(uses.length > 0, name);
    for (const action of uses) assert.match(action, /^actions\/[a-z-]+@[0-9a-f]{40} # v\d+(?:\.\d+)*$/, `${name}: ${action}`);
    assert.doesNotMatch(workflow, /agentbox|self-hosted|repository\.private|continue-on-error|pull_request_target/, name);
  }
});

test("release: a merge that changes the version publishes only the validated, smoke-tested tarball, in order, and nothing else publishes", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  // A push to master releases when its version is untagged; a manual run, which takes no inputs, is a dry run.
  const triggers = /\non:\n((?: {2}.*\n)+)/.exec(workflow)?.[1]!.split("\n").filter((line) => line && !line.trimStart().startsWith("#"));
  assert.deepEqual(triggers, ["  push:", "    branches: [master]", "  workflow_dispatch:"]);
  assert.match(workflow, /\npermissions:\n  contents: read\n/);
  // A release's runs never overlap or cancel each other, and a dry run never shares their queue.
  assert.match(workflow, /concurrency:\n(?: {2}#.*\n)*  group: release-\$\{\{ github\.event_name \}\}-\$\{\{ github\.ref \}\}\n  cancel-in-progress: false/);
  const jobs = workflowJobs(workflow);
  assert.deepEqual(Object.keys(jobs), ["plan", "validate", "browser", "package", "smoke", "release", "npm", "homebrew"]);
  const { plan, validate, browser, package: pack, smoke, release, npm, homebrew } = jobs as Record<string, string>;

  // Least privilege: write, OIDC and attestation rights exist only where they are used; every other job inherits read-only.
  for (const [name, job] of Object.entries(jobs)) {
    const expected = ({ release: ["contents: write", "id-token: write", "attestations: write"], npm: ["contents: read", "id-token: write"] } as Record<string, string[]>)[name] ?? [];
    assert.deepEqual(permissionsOf(job), expected, name);
    assert.equal(/secrets\./.test(job), name === "homebrew", `${name} secrets`);
    assert.equal(/github\.token/.test(job), name === "release", `${name} workflow token`);
    if (/actions\/checkout@/.test(job)) assert.match(job, /persist-credentials: false/, name);
  }
  assert.match(npm!, /^    environment: npm$/m);
  assert.match(homebrew!, /^    environment: homebrew$/m);

  // The plan job always runs; every other job needs it, and the checks run only when it says so.
  assert.doesNotMatch(plan!, /^    (?:if|needs):/m, "every run plans");
  assert.deepEqual([...plan!.matchAll(/^      (\w+): \$\{\{ steps\.plan\.outputs\.(\w+) \}\}$/gm)].map((output) => [output[1], output[2]]), [["tag", "tag"], ["check", "check"], ["publish", "publish"]]);
  for (const name of Object.keys(jobs).filter((name) => name !== "plan")) assert.ok(needsOf(jobs[name]!).includes("plan"), `${name} needs the plan`);
  for (const job of [validate!, browser!, pack!]) assert.match(job, /^    if: \$\{\{ needs\.plan\.outputs\.check == 'true' \}\}$/m);

  // A release push runs every check up to the installed smoke and then publishes; a dry run runs the checks, read-only, and nothing
  // that publishes; any other push stops after planning.
  const runs = (job: string, context: Omit<GateContext, "needs">): boolean => !/^    if:/m.test(job)
    || gate(job)({ needs: Object.fromEntries(needsOf(job).map((need) => [need, "success"])), vars: { NPM_PUBLISH: "true", HOMEBREW_TAP: "true" }, ...context });
  const reachable = (context: Omit<GateContext, "needs">): string[] => {
    const ran: string[] = [];
    for (const name of Object.keys(jobs)) if (needsOf(jobs[name]!).every((need) => ran.includes(need)) && runs(jobs[name]!, context)) ran.push(name);
    return ran;
  };
  assert.deepEqual(reachable({}), Object.keys(jobs), "a release push can run every job");
  for (const context of untagged) {
    const dispatched = reachable(context);
    assert.deepEqual(dispatched, context.plan!.check === "true" ? ["plan", "validate", "browser", "package", "smoke"] : ["plan"], JSON.stringify(context));
    for (const name of dispatched) assert.deepEqual(permissionsOf(jobs[name]!), [], `${name} is read-only on ${JSON.stringify(context)}`);
  }
  for (const [name, job] of Object.entries(jobs)) {
    if (permissionsOf(job).length || /^    environment:|secrets\.|github\.token/m.test(job)) for (const context of untagged) assert.equal(runs(job, context), false, `${name} needs a release push`);
  }

  // Every job that names the release takes it from the plan, never from the ref.
  assert.doesNotMatch(workflow, /GITHUB_REF_NAME|github\.ref_name/);
  for (const [name, job] of Object.entries(jobs).filter(([, job]) => /RELEASE_TAG/.test(job))) {
    assert.match(job, /^    env:\n      RELEASE_TAG: \$\{\{ needs\.plan\.outputs\.tag \}\}$/m, name);
    assert.ok(needsOf(job).includes("plan"), `${name} needs the plan for its tag`);
  }

  assert.deepEqual(/^        os: \[([^\]]+)\]$/m.exec(validate!)?.[1]!.split(", "), ["ubuntu-latest", "macos-latest"]);
  assert.match(validate!, /name: release validation \(\$\{\{ matrix.os \}\}\)/);
  assert.match(validate!, /run: node scripts\/release-check.ts --notes "\$RELEASE_TAG"/);
  assert.match(validate!, /run: npm run release:check/);
  assert.match(browser!, /name: release browser \(ubuntu-latest\)/);
  assert.deepEqual(browser!.match(/^    if: .*$/gm), ["    if: ${{ needs.plan.outputs.check == 'true' }}"], "a release's browser checks depend on nothing but the plan");
  assert.match(browser!, /SESSION_ANALYTICS_REQUIRE_BROWSER: '1'/);
  assert.match(pack!, /run: npm ci/);
  assert.match(pack!, /run: node scripts\/release-check.ts --notes "\$RELEASE_TAG"/);
  assert.match(pack!, /npm run pack:release\n.*release\/session-analytics\.tgz\n.*sha256sum .* > SHA256SUMS/);
  assert.match(pack!, /uses: actions\/upload-artifact@/);
  assert.deepEqual(needsOf(smoke!), ["plan", "package"]);
  assert.deepEqual(/^        os: \[([^\]]+)\]$/m.exec(smoke!)?.[1]!.split(", "), ["ubuntu-latest", "macos-latest"]);
  assert.deepEqual(/^        node: \[([^\]]+)\]$/m.exec(smoke!)?.[1]!.split(", "), ["'24.0.0'", "'24'", "'26'"], "the engines floor, the newest 24.x and Homebrew's Node.js");
  assert.match(smoke!, /run: node scripts\/smoke-installed.ts "release\/session-analytics-\$\{RELEASE_TAG#v\}.tgz"/);
  assert.doesNotMatch(smoke!, /npm ci|npm run/, "the smoke runs the packed tarball, not a fresh build");
  assert.deepEqual([...smoke!.matchAll(/^      - name: (.+)$/gm)].map((step) => step[1]),
    ["Check out", "Set up Node.js", "Download release files", "Verify checksums", "Install and run the tarball", "Check the Homebrew formula's style"]);

  // Every consumer of the packed files checks them against SHA256SUMS before using them.
  for (const [name, job, use] of [["smoke", smoke, "scripts/smoke-installed.ts"], ["smoke", smoke, "scripts/homebrew-formula.ts"], ["release", release, "attest-build-provenance"], ["npm", npm, "npm publish"], ["homebrew", homebrew, "scripts/homebrew-formula.ts"]] as const) {
    const download = job!.indexOf("uses: actions/download-artifact@"), verified = job!.indexOf("-c SHA256SUMS");
    assert.ok(download > 0 && verified > download && job!.indexOf(use) > verified, `${name} verifies checksums before ${use}`);
  }

  // Nothing publishes unless validation, the browser check, packaging and every installed smoke succeeded.
  assert.deepEqual(needsOf(release!), ["plan", "validate", "browser", "package", "smoke"]);
  const canRelease = gate(release!);
  for (const validated of results) for (const browsed of results) for (const packed of results) for (const smoked of results) {
    const needs = { validate: validated, browser: browsed, package: packed, smoke: smoked };
    assert.equal(canRelease({ needs }), Object.values(needs).every((result) => result === "success"), JSON.stringify(needs));
    assert.equal(canRelease({ needs, cancelled: true }), false, "a cancelled workflow never publishes");
    for (const context of untagged) assert.equal(canRelease({ needs, ...context }), false, `${JSON.stringify(context)} never publishes`);
  }
  const upstream = (name: string): string[] => needsOf(jobs[name]!).flatMap((need) => [need, ...upstream(need)]);
  for (const name of ["release", "npm", "homebrew"]) for (const required of ["validate", "browser", "package", "smoke"]) assert.ok(upstream(name).includes(required), `${name} needs ${required}`);

  // The release job runs no repository code; the tag exists at this commit, and files reach a draft, before it is published as the latest release.
  assert.doesNotMatch(release!, /actions\/checkout|npm ci|npm run|scripts\//);
  const order = ["-c SHA256SUMS", "attest-build-provenance", "/git/refs", "draft: true", "upload_url", "draft: false"].map((step) => release!.indexOf(step));
  assert.ok(order.every((index, position) => index > 0 && (position === 0 || index > order[position - 1]!)), `release order ${order}`);
  assert.match(release!, /subject-path: release\/session-analytics-\*\.tgz/);
  assert.match(release!, /make_latest: makeLatest \? 'true' : 'false'/);
  for (const asset of ["`session-analytics-${version}.tgz`", "'session-analytics.tgz'", "'SHA256SUMS'"]) assert.ok(release!.includes(asset), asset);

  // npm and Homebrew follow the GitHub Release and stay off until their one-time setup sets a repository variable.
  assert.deepEqual(needsOf(npm!), ["plan", "release"]);
  const canPublishNpm = gate(npm!);
  for (const released of results) for (const flag of ["true", "false", "", undefined]) {
    const vars: Record<string, string> = flag === undefined ? {} : { NPM_PUBLISH: flag };
    assert.equal(canPublishNpm({ needs: { release: released }, vars }), released === "success" && flag === "true", `release=${released}, NPM_PUBLISH=${flag}`);
    assert.equal(canPublishNpm({ needs: { release: released }, vars, cancelled: true }), false);
    for (const context of untagged) assert.equal(canPublishNpm({ needs: { release: released }, vars, ...context }), false, JSON.stringify(context));
  }
  const [major, minor, patch] = /npm install --global npm@(\d+)\.(\d+)\.(\d+)\n/.exec(npm!)?.slice(1).map(Number) ?? [];
  assert.ok(major !== undefined && minor !== undefined && patch !== undefined, "npm is pinned to an exact version");
  assert.ok(major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1))), "trusted publishing needs npm 11.5.1 or newer");
  assert.match(npm!, /registry-url: https:\/\/registry\.npmjs\.org/);
  assert.match(npm!, /npm publish "\.\/release\/session-analytics-\$V\.tgz" --tag "\$DIST_TAG"/, "a path npm cannot mistake for a GitHub shorthand");
  const [published, verified, installed] = ["npm publish", "dist.integrity 2>/dev/null || true", "scripts/smoke-installed.ts \"session-analytics@"].map((step) => npm!.indexOf(step));
  assert.ok(published! > 0 && verified! > published! && installed! > verified!, "npm checks the registry integrity, then installs the registry version and runs it");
  assert.deepEqual(needsOf(homebrew!), ["plan", "release", "npm"]);
  const canUpdateTap = gate(homebrew!);
  for (const released of results) for (const npmResult of results) for (const flag of ["true", ""]) for (const tag of ["v1.2.3", "v1.3.0-rc.1"]) {
    const expected = released === "success" && (npmResult === "success" || npmResult === "skipped") && flag === "true" && !tag.includes("-");
    assert.equal(canUpdateTap({ needs: { release: released, npm: npmResult }, plan: { ...releasing, tag }, vars: { HOMEBREW_TAP: flag } }), expected, `release=${released}, npm=${npmResult}, HOMEBREW_TAP=${flag}, ${tag}`);
    for (const context of untagged) assert.equal(canUpdateTap({ needs: { release: released, npm: npmResult }, vars: { HOMEBREW_TAP: flag }, ...context }), false, JSON.stringify(context));
  }
  assert.match(homebrew!, /node scripts\/homebrew-formula.ts --version "\$V" --sha256 /);
  assert.match(homebrew!, /^    runs-on: macos-latest$/m, "Homebrew installs and tests the formula before the tap receives it");
  const tapOrder = ["scripts/homebrew-formula.ts", "brew install --formula", "brew test", "brew audit --strict", "git -C \"$WORK/tap\" push"].map((step) => homebrew!.indexOf(step));
  assert.ok(tapOrder.every((index, position) => index > 0 && (position === 0 || index > tapOrder[position - 1]!)), `homebrew order ${tapOrder}`);

  // The tap takes a git push over SSH with a deploy key that only this step sees, to github.com's pinned host keys only.
  const commit = stepOf(homebrew!, "Commit the formula to the tap");
  assert.deepEqual([...workflow.matchAll(/secrets\.(\w+)/g)].map((match) => match[1]), ["TAP_DEPLOY_KEY"], "the workflow's only secret");
  assert.match(commit, /\n        env:\n          TAP_DEPLOY_KEY: \$\{\{ secrets\.TAP_DEPLOY_KEY \}\}\n/);
  assert.doesNotMatch(workflow, /api\.github\.com\/repos\/rokas-tarasevicius\/homebrew-tap/, "no token-based contents API call to the tap");
  assert.match(commit, /TAP=git@github\.com:rokas-tarasevicius\/homebrew-tap\.git /);
  assert.match(commit, /git clone --quiet --depth 1 --branch main "\$TAP"/);
  const sshCommand = /GIT_SSH_COMMAND="([^"]*)"/.exec(commit)?.[1] ?? "";
  for (const option of ["-F /dev/null", "-o IdentitiesOnly=yes", "-o BatchMode=yes", "-o StrictHostKeyChecking=yes", "-o UserKnownHostsFile=", "-o GlobalKnownHostsFile=/dev/null"]) assert.ok(sshCommand.includes(option), option);
  assert.deepEqual(hostKeyFingerprints(/<<'HOSTS'\n([\s\S]*?)\nHOSTS\n/.exec(stepScript(homebrew!, "Commit the formula to the tap"))?.[1] ?? ""), githubHostKeys);
});

test("release: the plan releases an untagged version or resumes its own tag, skips a push that changed no version, and fails a dry run of a released one", async () => {
  const { plan } = workflowJobs(await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")) as Record<string, string>;
  // The real step against a local repository standing in for GitHub; only an exact tag counts, and an unreadable repository fails.
  const server = await mkdtemp(join(tmpdir(), "session-analytics-tags-"));
  try {
    const env = { PATH: process.env["PATH"], HOME: server, GIT_CONFIG_NOSYSTEM: "1" };
    const git = (...args: string[]): string => {
      const result = spawnSync("git", args, { encoding: "utf8", env });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    const bare = join(server, "o", "r.git"), work = join(server, "work");
    git("init", "--quiet", "--bare", bare);
    await mkdir(work);
    await writeFile(join(work, "package.json"), JSON.stringify({ version: "1.2.3" }));
    const commitTree = (message: string) => git("-C", bare, "-c", "user.name=Maintainer", "-c", "user.email=maintainer@example.com", "commit-tree", git("-C", bare, "mktree"), "-m", message);
    const [head, older] = [commitTree("Release"), commitTree("Older")];
    const annotate = (tag: string, commit: string) => git("-C", bare, "-c", "user.name=Maintainer", "-c", "user.email=maintainer@example.com", "tag", "--annotate", "-m", tag, tag, commit);
    const cases: Array<[string, Array<[string, string]>, string, "plain" | "annotated", number, Record<string, string> | null, RegExp]> = [
      ["push", [["v1.2.2", older], ["v1.2.30", older], ["v1.2.3-rc.1", older]], "o/r", "plain", 0, { check: "true", publish: "true" }, new RegExp(`^Releasing v1\\.2\\.3 from ${head}\\.\\n$`)],
      ["push", [["v1.2.3", head]], "o/r", "plain", 0, { check: "true", publish: "true" }, /^v1\.2\.3 is this commit; resuming its release\.\n$/],
      ["push", [["v1.2.3", head]], "o/r", "annotated", 0, { check: "true", publish: "true" }, /^v1\.2\.3 is this commit; resuming its release\.\n$/],
      ["push", [["v1.2.3", older]], "o/r", "plain", 0, { check: "false", publish: "false" }, new RegExp(`^v1\\.2\\.3 is already released from ${older}; this push changes no version, so nothing is released\\.\\n$`)],
      ["push", [["v1.2.3", older]], "o/r", "annotated", 0, { check: "false", publish: "false" }, /changes no version/],
      ["workflow_dispatch", [["v1.2.2", older], ["v1.2.30", older]], "o/r", "plain", 0, { check: "true", publish: "false" }, new RegExp(`^v1\\.2\\.3 is unused; this dry run checks ${head}\\.\\n$`)],
      ["workflow_dispatch", [["v1.2.3", head]], "o/r", "plain", 1, null, /^v1\.2\.3 is already tagged; bump the version before a dry run\.\n$/],
      ["push", [], "o/missing", "plain", 1, null, /Reading the repository's tags failed\.\n$/],
    ];
    for (const [event, tags, repository, kind, status, outputs, message] of cases) {
      const label = `${event} ${repository} with ${tags.map(([tag]) => tag).join(", ")} (${kind})`;
      for (const tag of git("-C", bare, "tag", "--list").split("\n").filter(Boolean)) git("-C", bare, "tag", "--delete", tag);
      for (const [tag, commit] of tags) kind === "annotated" ? annotate(tag, commit) : git("-C", bare, "tag", tag, commit);
      const output = join(server, "output");
      await rm(output, { force: true });
      const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", stepScript(plan!, "Plan the release")], {
        cwd: work, encoding: "utf8", env: { ...env, GITHUB_EVENT_NAME: event, GITHUB_SERVER_URL: pathToFileURL(server).href, GITHUB_REPOSITORY: repository, GITHUB_SHA: head, GITHUB_OUTPUT: output },
      });
      assert.equal(result.status, status, `${label}: ${result.stderr}`);
      assert.match(status === 0 ? result.stdout : result.stderr, message, label);
      const written = Object.fromEntries((await readFile(output, "utf8")).trim().split("\n").map((line) => line.split("=") as [string, string]));
      assert.deepEqual(written, { tag: "v1.2.3", ...outputs }, label);
    }
  } finally { await rm(server, { recursive: true, force: true }); }
});

/** A job's step, from its `- name:` line to the next step. */
function stepOf(job: string, name: string): string {
  const step = job.split(/^(?=      - name: )/m).find((candidate) => candidate.startsWith(`      - name: ${name}\n`));
  assert.ok(step, name);
  return step;
}

/** A step's `run:` script, dedented; for an inline `node <<'NODE'` script, the script alone. */
function stepScript(job: string, name: string): string {
  const step = stepOf(job, name);
  const block = /^        run: \|\n((?:(?: {10}.*)?\n)+)/m.exec(step)?.[1];
  assert.ok(block, `${name} runs a script`);
  const script = block.split("\n").map((line) => line.slice(10)).join("\n");
  return /<<'NODE'\n([\s\S]*?)\nNODE\n/.exec(script)?.[1] ?? script;
}

/** Run a workflow's inline Node script against canned GitHub API replies; returns the API calls it made. */
async function runAgainstApi(script: string, directory: string, routes: Record<string, { status: number, json?: unknown }>, env: Record<string, string>, status = 0): Promise<Array<{ method: string, path: string, body?: any }>> {
  const mock = join(directory, "mock-fetch.mjs"), log = join(directory, "calls.jsonl");
  await writeFile(mock, `import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
const routes = JSON.parse(process.env.MOCK_ROUTES);
globalThis.fetch = async (url, init = {}) => {
  const method = init.method ?? "GET", { host, pathname, search } = new URL(url), body = init.body === undefined ? undefined : Buffer.from(init.body);
  const upload = host === "uploads.github.com";
  appendFileSync(process.env.MOCK_LOG, JSON.stringify({ method, path: pathname + search, body: body && !upload ? JSON.parse(body.toString()) : undefined }) + "\\n");
  const reply = upload ? { status: 201, json: { size: body.length, digest: "sha256:" + createHash("sha256").update(body).digest("hex") } }
    : routes[method + " " + pathname + search] ?? routes[method + " " + pathname] ?? { status: 404, json: { message: "Not Found" } };
  return new Response(reply.json === undefined ? null : JSON.stringify(reply.json), { status: reply.status });
};
`);
  await rm(log, { force: true });
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(mock).href, "--input-type=module"], {
    cwd: directory, input: script, encoding: "utf8", env: { PATH: process.env["PATH"], ...env, MOCK_ROUTES: JSON.stringify(routes), MOCK_LOG: log },
  });
  assert.equal(result.status, status, result.stderr);
  return (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}

test("release: a tag published after a newer release never moves GitHub, npm or Homebrew back to it", async () => {
  const { release, npm, homebrew } = workflowJobs(await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")) as Record<string, string>;
  const directory = await mkdtemp(join(tmpdir(), "session-analytics-latest-"));
  try {
    await mkdir(join(directory, "release"));
    for (const name of ["session-analytics-1.9.0.tgz", "session-analytics.tgz", "SHA256SUMS"]) await writeFile(join(directory, "release", name), `${name} bytes\n`);
    await writeFile(join(directory, "notes.md"), "- Notes.\n");
    const publishRelease = stepScript(release!, "Publish GitHub Release"), sha = "a".repeat(40), env = { RELEASE_TAG: "v1.9.0", GITHUB_SHA: sha, GITHUB_REPOSITORY: "o/r", GH_TOKEN: "token" };
    for (const [latest, expected] of [["v1.10.0", "false"], ["v1.9.1", "false"], ["v1.8.7", "true"], [null, "true"]] as const) {
      const calls = await runAgainstApi(publishRelease, directory, {
        "POST /repos/o/r/git/refs": { status: 201, json: { ref: "refs/tags/v1.9.0", object: { sha, type: "commit" } } },
        "GET /repos/o/r/releases?per_page=100&page=1": { status: 200, json: [] },
        "POST /repos/o/r/releases": { status: 201, json: { id: 7, assets: [], upload_url: "https://uploads.github.com/repos/o/r/releases/7/assets{?name,label}" } },
        "PATCH /repos/o/r/releases/7": { status: 200, json: { id: 7 } },
        ...(latest ? { "GET /repos/o/r/releases/latest": { status: 200, json: { tag_name: latest } } } : {}),
      }, env);
      assert.deepEqual(calls.slice(0, 2), [{ method: "GET", path: "/repos/o/r/git/ref/tags/v1.9.0" }, { method: "POST", path: "/repos/o/r/git/refs", body: { ref: "refs/tags/v1.9.0", sha } }], "the tag is created at this commit first");
      assert.deepEqual(calls.at(-1), { method: "PATCH", path: "/repos/o/r/releases/7", body: { draft: false, make_latest: expected } }, `latest ${latest}`);
    }
    // A re-run finds its own tag and goes on; a tag at another commit stops before any release exists.
    const releaseRoutes = { "GET /repos/o/r/releases?per_page=100&page=1": { status: 200, json: [] }, "POST /repos/o/r/releases": { status: 201, json: { id: 7, assets: [], upload_url: "https://uploads.github.com/repos/o/r/releases/7/assets{?name,label}" } }, "PATCH /repos/o/r/releases/7": { status: 200, json: { id: 7 } } };
    const resumed = await runAgainstApi(publishRelease, directory, { "GET /repos/o/r/git/ref/tags/v1.9.0": { status: 200, json: { object: { sha, type: "commit" } } }, ...releaseRoutes }, env);
    assert.ok(!resumed.some((call) => call.path === "/repos/o/r/git/refs"), "an existing tag at this commit is kept");
    assert.equal(resumed.at(-1)!.body.draft, false);
    const annotated = await runAgainstApi(publishRelease, directory, { "GET /repos/o/r/git/ref/tags/v1.9.0": { status: 200, json: { object: { sha: "c".repeat(40), type: "tag" } } },
      ["GET /repos/o/r/git/tags/" + "c".repeat(40)]: { status: 200, json: { object: { sha, type: "commit" } } }, ...releaseRoutes }, env);
    assert.deepEqual(annotated[1], { method: "GET", path: `/repos/o/r/git/tags/${"c".repeat(40)}` }, "an annotated tag is followed to its commit");
    assert.equal(annotated.at(-1)!.body.draft, false, "an annotated tag at this commit resumes");
    const annotatedElsewhere = await runAgainstApi(publishRelease, directory, { "GET /repos/o/r/git/ref/tags/v1.9.0": { status: 200, json: { object: { sha: "c".repeat(40), type: "tag" } } },
      ["GET /repos/o/r/git/tags/" + "c".repeat(40)]: { status: 200, json: { object: { sha: "b".repeat(40), type: "commit" } } }, ...releaseRoutes }, env, 1);
    assert.equal(annotatedElsewhere.length, 2, "nothing is published under an annotated tag at another commit");
    const elsewhere = await runAgainstApi(publishRelease, directory, { "GET /repos/o/r/git/ref/tags/v1.9.0": { status: 200, json: { object: { sha: "b".repeat(40), type: "commit" } } }, ...releaseRoutes }, env, 1);
    assert.deepEqual(elsewhere, [{ method: "GET", path: "/repos/o/r/git/ref/tags/v1.9.0" }], "nothing is published under a tag at another commit");

    // npm: the real step with a recording npm on PATH; openssl hashes the tarball as on the runner.
    const bin = join(directory, "bin"), log = join(directory, "npm.log");
    await mkdir(bin);
    await writeFile(join(bin, "npm"), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$MOCK_LOG"\ncase "$*" in\n  "view session-analytics dist-tags.latest") printf \'%s\\n\' "$MOCK_LATEST" ;;\n  view*) exit 1 ;;\nesac\n');
    await chmod(join(bin, "npm"), 0o755);
    const publishNpm = stepScript(npm!, "Publish the release tarball");
    for (const [tag, latest, expected] of [["v1.9.0", "1.10.0", "backport"], ["v1.9.0", "1.9.1", "backport"], ["v1.9.0", "1.8.7", "latest"], ["v1.9.0", "", "latest"], ["v1.10.0", "1.9.0", "latest"]] as const) {
      await writeFile(join(directory, "release", `session-analytics-${tag.slice(1)}.tgz`), "bytes\n");
      await rm(log, { force: true });
      const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", publishNpm], {
        cwd: directory, encoding: "utf8", env: { PATH: `${bin}${delimiter}${process.env["PATH"]}`, RELEASE_TAG: tag, MOCK_LOG: log, MOCK_LATEST: latest },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal((await readFile(log, "utf8")).trim().split("\n").at(-1), `publish ./release/session-analytics-${tag.slice(1)}.tgz --tag ${expected}`, `${tag} after ${latest || "none"}`);
    }

    // Homebrew: never replace a newer formula, and make no commit for an identical one.
    const commitFormula = stepScript(homebrew!, "Commit the formula to the tap");
    const sha256 = "0123456789abcdef".repeat(4), formula = homebrewFormula("1.9.0", sha256);
    await writeFile(join(directory, "session-analytics.rb"), formula);
    for (const [tapped, commits] of [["1.10.0", false], ["1.9.0", false], ["1.8.7", true], [null, true]] as const) {
      const tap = await runTapStep(commitFormula, directory, { "README.md": "# Tap\n", ...(tapped ? { "Formula/session-analytics.rb": homebrewFormula(tapped, sha256) } : {}) });
      assert.equal(tap.status, 0, tap.stderr);
      assert.equal(tap.commits.length, commits ? 2 : 1, `tap at ${tapped}`);
      assert.equal(tap.formula, commits ? formula : homebrewFormula(tapped!, sha256), `tap at ${tapped}`);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

/** A stand-in `ssh` for git: records what ssh was given, then serves the named repository from FAKE_SSH_ROOT as GitHub's sshd would. */
const fakeGitSsh = `#!/usr/bin/env node
const { appendFileSync, readFileSync, statSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2), options = {};
let at = 0;
for (; args[at].startsWith("-"); at += 2) {
  if (args[at] !== "-o") options[args[at]] = args[at + 1];
  else { const [name, ...value] = args[at + 1].split("="); options[name] = value.join("="); }
}
const [destination, command] = args.slice(at), key = options["-i"];
appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify({ destination, command, options, keyMode: statSync(key).mode & 0o777, key: readFileSync(key, "utf8"),
  knownHosts: readFileSync(options.UserKnownHostsFile, "utf8"), secretInEnvironment: "TAP_DEPLOY_KEY" in process.env }) + "\\n");
if (process.env.FAKE_SSH_REFUSE && command.startsWith(process.env.FAKE_SSH_REFUSE)) { process.stderr.write(destination + ": Permission denied (publickey).\\n"); process.exit(255); }
const result = spawnSync("sh", ["-c", command.replace(/^git-/, "git ")], { cwd: process.env.FAKE_SSH_ROOT, stdio: "inherit" });
process.exit(result.status ?? 1);
`;
const tapKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nc2Vzc2lvbi1hbmFseXRpY3MgdGVzdCBrZXk=\n-----END OPENSSH PRIVATE KEY-----";
type SshCall = { destination: string, command: string, options: Record<string, string>, keyMode: number, key: string, knownHosts: string, secretInEnvironment: boolean };

/** Run the tap step as the runner would, against a local bare tap whose `branches` hold `seed`, the first being its default, or an empty tap when it is null. */
async function runTapStep(script: string, directory: string, seed: Record<string, string> | null, env: Record<string, string> = {}, branches = ["main"]) {
  const root = await mkdtemp(join(directory, "tap-")), bin = join(root, "bin"), runnerTemp = join(root, "runner-temp"), home = join(root, "home"), log = join(root, "ssh.jsonl");
  const bare = join(root, "server", "rokas-tarasevicius", "homebrew-tap.git");
  await Promise.all([mkdir(bin), mkdir(runnerTemp), mkdir(home)]);
  await writeFile(join(bin, "ssh"), fakeGitSsh, { mode: 0o755 });
  const gitEnv = { PATH: `${bin}${delimiter}${process.env["PATH"]}`, HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args: string[]): string => {
    const result = spawnSync("git", args, { encoding: "utf8", env: gitEnv });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "--quiet", "--bare", "--initial-branch", branches[0]!, bare);
  if (seed) {
    const work = join(root, "seed");
    git("init", "--quiet", "--initial-branch", "main", work);
    for (const [name, text] of Object.entries(seed)) {
      await mkdir(dirname(join(work, name)), { recursive: true });
      await writeFile(join(work, name), text);
    }
    git("-C", work, "add", ".");
    git("-C", work, "-c", "user.name=Maintainer", "-c", "user.email=maintainer@example.com", "commit", "--quiet", "-m", "Seed the tap");
    for (const branch of branches) git("-C", work, "push", "--quiet", bare, `HEAD:refs/heads/${branch}`);
  }
  const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", script], {
    cwd: directory, encoding: "utf8",
    env: { ...gitEnv, RUNNER_TEMP: runnerTemp, RELEASE_TAG: "v1.9.0", TAP_DEPLOY_KEY: tapKey, FAKE_SSH_LOG: log, FAKE_SSH_ROOT: join(root, "server"), ...env },
  });
  const calls: SshCall[] = await readFile(log, "utf8").then((text) => text.trim().split("\n").map((line) => JSON.parse(line)), () => []);
  const hasMain = spawnSync("git", ["-C", bare, "rev-parse", "--verify", "--quiet", "refs/heads/main"], { env: gitEnv }).status === 0;
  const formula = hasMain ? spawnSync("git", ["-C", bare, "show", "main:Formula/session-analytics.rb"], { encoding: "utf8", env: gitEnv }) : null;
  return {
    status: result.status, stdout: result.stdout, stderr: result.stderr, calls, leftovers: await readdir(runnerTemp),
    heads: git("-C", bare, "for-each-ref", "--format=%(refname)", "refs/heads").split("\n").filter(Boolean),
    commits: hasMain ? git("-C", bare, "log", "--format=%an <%ae>|%cn <%ce>|%s", "main").split("\n") : [],
    files: hasMain ? git("-C", bare, "ls-tree", "-r", "--name-only", "main").split("\n") : [],
    formula: formula?.status === 0 ? formula.stdout : null,
  };
}

test("release: the tap takes one bot commit over SSH to pinned host keys, and the deploy key never outlives the step", async () => {
  const { homebrew } = workflowJobs(await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")) as Record<string, string>;
  const script = stepScript(homebrew!, "Commit the formula to the tap");
  const directory = await mkdtemp(join(tmpdir(), "session-analytics-tap-"));
  try {
    const formula = homebrewFormula("1.9.0", "0123456789abcdef".repeat(4)), bot = "github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>";
    await writeFile(join(directory, "session-analytics.rb"), formula);
    // An empty tap and a tap with only a README on main both get main with the formula, in one commit by the bot.
    for (const seed of [null, { "README.md": "# Tap\n" }]) {
      const tap = await runTapStep(script, directory, seed);
      assert.equal(tap.status, 0, tap.stderr);
      assert.match(tap.stdout, /Updated Formula\/session-analytics\.rb in rokas-tarasevicius\/homebrew-tap to v1\.9\.0/);
      assert.deepEqual(tap.commits, [`${bot}|${bot}|session-analytics 1.9.0`, ...(seed ? ["Maintainer <maintainer@example.com>|Maintainer <maintainer@example.com>|Seed the tap"] : [])]);
      assert.deepEqual(tap.files, seed ? ["Formula/session-analytics.rb", "README.md"] : ["Formula/session-analytics.rb"]);
      assert.equal(tap.formula, formula);
      assert.deepEqual(tap.calls.map((call) => call.command), [
        "git-upload-pack 'rokas-tarasevicius/homebrew-tap.git'", ...(seed ? ["git-upload-pack 'rokas-tarasevicius/homebrew-tap.git'"] : []), "git-receive-pack 'rokas-tarasevicius/homebrew-tap.git'",
      ]);
      // ssh sees only the pinned host keys and the key in a private file; nothing it starts inherits the secret.
      for (const call of tap.calls) {
        assert.equal(call.destination, "git@github.com");
        assert.deepEqual([call.options["-F"], call.options["IdentitiesOnly"], call.options["BatchMode"], call.options["StrictHostKeyChecking"], call.options["GlobalKnownHostsFile"]], ["/dev/null", "yes", "yes", "yes", "/dev/null"]);
        assert.equal(call.keyMode, 0o600);
        assert.equal(call.key, `${tapKey}\n`);
        assert.deepEqual(hostKeyFingerprints(call.knownHosts), githubHostKeys);
        assert.equal(call.secretInEnvironment, false);
      }
      assert.deepEqual(tap.leftovers, [], "the key and the clone are removed");
    }
    // A missing secret, a refused read and a refused push each fail, commit nothing and leave no key behind.
    const failures: Array<[Record<string, string>, RegExp]> = [
      [{ TAP_DEPLOY_KEY: "" }, /no TAP_DEPLOY_KEY secret/], [{ FAKE_SSH_REFUSE: "git-upload-pack" }, /Reading the tap failed/], [{ FAKE_SSH_REFUSE: "git-receive-pack" }, /Permission denied/],
    ];
    for (const [env, message] of failures) {
      const tap = await runTapStep(script, directory, { "README.md": "# Tap\n" }, env);
      assert.notEqual(tap.status, 0, JSON.stringify(env));
      assert.match(tap.stderr, message);
      assert.equal(tap.commits.length, 1, JSON.stringify(env));
      assert.deepEqual(tap.leftovers, [], JSON.stringify(env));
      if ("TAP_DEPLOY_KEY" in env) assert.deepEqual(tap.calls, [], "no secret, no connection");
    }
    // `brew tap` reads only the default branch, so a tap whose default is not main, with or without a main, is read and never pushed to.
    for (const branches of [["master"], ["master", "main"]]) {
      const tap = await runTapStep(script, directory, { "README.md": "# Tap\n" }, {}, branches);
      assert.notEqual(tap.status, 0, branches.join(", "));
      assert.match(tap.stderr, /The tap's default branch is not main; nothing was committed\./);
      assert.deepEqual(tap.heads, branches.map((branch) => `refs/heads/${branch}`).sort(), "no orphan main appears");
      assert.equal(tap.commits.length, branches.includes("main") ? 1 : 0, branches.join(", "));
      assert.deepEqual(tap.calls.map((call) => call.command), ["git-upload-pack 'rokas-tarasevicius/homebrew-tap.git'"], branches.join(", "));
      assert.deepEqual(tap.leftovers, [], branches.join(", "));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("release: the Homebrew formula installs the release tarball with Homebrew's Node", (t) => {
  const sha256 = "0123456789abcdef".repeat(4);
  const formula = homebrewFormula("1.2.3", sha256);
  assert.match(formula, /^class SessionAnalytics < Formula$/m);
  assert.match(formula, /^  desc "Content-free analytics for local coding-agent sessions"$/m);
  assert.match(formula, /^  homepage "https:\/\/github.com\/rokas-tarasevicius\/session-analytics"$/m);
  assert.match(formula, /^  url "https:\/\/github.com\/rokas-tarasevicius\/session-analytics\/releases\/download\/v1\.2\.3\/session-analytics-1\.2\.3\.tgz"$/m, "the versioned asset the release job uploads");
  assert.match(formula, new RegExp(`^  sha256 "${sha256}"$`, "m"));
  assert.match(formula, /^  license "MIT"$/m);
  assert.match(formula, /^  depends_on "node"$/m);
  assert.match(formula, /^    system "npm", "install", \*std_npm_args$/m);
  assert.match(formula, /^    env = \{ PATH: "#\{formula_opt_bin\("node"\)\}:\$PATH" \}\n    \(bin\/"session-analytics"\)\.write_env_script libexec\/"bin\/session-analytics", env$/m);
  assert.doesNotMatch(formula, /Formula\[|Formulary\.|\.opt_(?:bin|lib|libexec|include|prefix)\b/, "Homebrew's FormulaPathMethods cop wants formula_opt_* helpers");
  for (const line of homebrewFormula("100.100.100", sha256).split("\n")) if (!line.startsWith("  url ")) assert.ok(line.length <= 118, `Homebrew's style check allows 118 columns: ${line}`);
  assert.match(formula, /^    ENV\["HOME"\] = testpath$/m);
  assert.match(formula, /shell_output\("#\{bin\}\/session-analytics --version"\)/);
  assert.match(formula, /shell_output\("#\{bin\}\/session-analytics report --json --offline --no-index"\)/);
  for (const version of ["1.2", "v1.2.3", "1.2.3-rc.1", '1.2.3"; system "x', "1.2.3\n"]) assert.throws(() => homebrewFormula(version, sha256), /stable X\.Y\.Z/, version);
  for (const digest of ["", sha256.toUpperCase(), sha256.slice(1), `${sha256.slice(1)}"`]) assert.throws(() => homebrewFormula("1.2.3", digest), /sha256/, digest);
  const ruby = spawnSync("ruby", ["-c"], { input: formula, encoding: "utf8" });
  if (ruby.error) t.diagnostic("Ruby is unavailable; formula syntax not checked.");
  else assert.equal(ruby.status, 0, ruby.stderr);
});

test("release: while the tap is on, every run checks the style of the formula a release would commit, on one macOS smoke leg", async (t) => {
  const { smoke, homebrew } = workflowJobs(await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")) as Record<string, string>;
  const style = stepOf(smoke!, "Check the Homebrew formula's style");
  // The macOS leg on the newest Node.js, Homebrew's own, on a release push and on every dry run alike, while the tap is on; with the
  // tap off, Homebrew never holds back the other channels. It needs no secret or permission.
  const condition = /^        if: (.+)$/m.exec(style)?.[1] ?? "";
  assert.doesNotMatch(condition, /needs\.|secrets\./, "the step depends on the matrix leg, the run and the tap switch alone");
  const [oses, nodes] = ["os", "node"].map((key) => new RegExp(`^        ${key}: \\[([^\\]]+)\\]$`, "m").exec(smoke!)?.[1]!.split(", ").map((value) => value.replace(/^'|'$/g, "")) ?? []);
  const legs = oses!.flatMap((os) => nodes!.map((node) => ({ os, node })));
  for (const { event, ref } of [{ event: "push", ref: "refs/heads/master" }, ...untagged.filter(({ event }) => event === "workflow_dispatch").map(({ event, ref }) => ({ event: event!, ref: ref! })), { event: "workflow_dispatch", ref: "refs/heads/fix/a-branch" }]) {
    const github = { event_name: event, ref, ref_name: ref.replace(/^refs\/(?:heads|tags)\//, "") };
    for (const vars of [{ HOMEBREW_TAP: "true" }, { HOMEBREW_TAP: "false" }, {}] as Array<Record<string, string>>) {
      const checks = legs.filter((matrix) => new Function("matrix", "github", "vars", `return ${condition};`)(matrix, github, vars));
      assert.deepEqual(checks, vars["HOMEBREW_TAP"] === "true" ? [{ os: "macos-latest", node: nodes!.at(-1) }] : [], `${event} ${ref} ${JSON.stringify(vars)}`);
    }
  }
  assert.match(style, /\n        env:\n          HOMEBREW_NO_AUTO_UPDATE: '1'\n/);
  assert.doesNotMatch(stepScript(smoke!, "Check the Homebrew formula's style"), /brew (?:install|test|audit|update|upgrade)\b/, "a style check installs nothing");
  // The same render command as the homebrew job, for the version the run names and the tarball whose checksum it verified.
  const render = (job: string) => /^ +(node scripts\/homebrew-formula\.ts .*)$/m.exec(job)?.[1];
  assert.ok(render(style) && render(style) === render(homebrew!), "the formula the homebrew job would commit");

  if (spawnSync("shasum", ["--version"]).error) return t.diagnostic("shasum is unavailable; the steps were not run.");
  const directory = await realpath(await mkdtemp(join(tmpdir(), "session-analytics-formula-style-")));
  try {
    const [bin, work, tap, log, styled] = ["bin", "work", "tap", "brew.log", "styled.rb"].map((name) => join(directory, name)) as [string, string, string, string, string];
    await Promise.all([bin, join(work, "scripts"), join(work, "release")].map((path) => mkdir(path, { recursive: true })));
    await copyFile(fileURLToPath(new URL("../scripts/homebrew-formula.ts", import.meta.url)), join(work, "scripts", "homebrew-formula.ts"));
    const tarball = Buffer.from("synthetic release tarball\n");
    await writeFile(join(work, "release", "session-analytics-1.2.3.tgz"), tarball);
    // A stand-in brew: one local tap, and `brew style` keeps the file it was given and exits with BREW_STYLE_STATUS.
    await writeFile(join(bin, "brew"), `#!/bin/sh
printf '%s\\n' "$*" >> "$BREW_LOG"
case "$1" in
  tap-new) mkdir -p "$BREW_TAP/Formula" ;;
  --repository) printf '%s\\n' "$BREW_TAP" ;;
  style) cp "$3" "$BREW_STYLED"; exit "$BREW_STYLE_STATUS" ;;
esac
`, { mode: 0o755 });
    const run = (job: string, step: string, env: Record<string, string>) => spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", stepScript(job, step)], {
      cwd: work, encoding: "utf8",
      env: { PATH: [bin, dirname(process.execPath), process.env["PATH"]].join(delimiter), BREW_LOG: log, BREW_TAP: tap, BREW_STYLED: styled, BREW_STYLE_STATUS: "0", ...env },
    });
    const expected = homebrewFormula("1.2.3", createHash("sha256").update(tarball).digest("hex"));

    const checked = run(smoke!, "Check the Homebrew formula's style", { RELEASE_TAG: "v1.2.3" });
    assert.equal(checked.status, 0, checked.stderr);
    assert.equal(await readFile(styled, "utf8"), expected);
    assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"),
      ["tap-new --no-git session-analytics/release-check", "--repository session-analytics/release-check", `style --formula ${join(tap, "Formula", "session-analytics.rb")}`]);
    const rendered = run(homebrew!, "Render the formula", { RELEASE_TAG: "v1.2.3" });
    assert.equal(rendered.status, 0, rendered.stderr);
    assert.equal(await readFile(join(work, "session-analytics.rb"), "utf8"), expected, "the homebrew job renders the same bytes for the release");

    assert.equal(run(smoke!, "Check the Homebrew formula's style", { RELEASE_TAG: "v1.2.3", BREW_STYLE_STATUS: "1" }).status, 1, "a style offence fails the leg");

    // A prerelease leaves the tap alone, so its leg passes without rendering a formula or calling brew.
    await Promise.all([log, styled, join(work, "session-analytics.rb")].map((path) => rm(path)));
    const prerelease = run(smoke!, "Check the Homebrew formula's style", { RELEASE_TAG: "v1.2.3-rc.1", BREW_STYLE_STATUS: "1" });
    assert.equal(prerelease.status, 0, prerelease.stderr);
    assert.match(prerelease.stdout, /Prereleases leave the tap alone\./);
    assert.deepEqual((await readdir(directory)).sort(), ["bin", "tap", "work"], "no brew call");
    assert.deepEqual((await readdir(work)).sort(), ["release", "scripts"], "no formula rendered");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("release: notes exclude unreleased and older changes; mismatched tags, metadata and compare links fail", () => {
  const links = "[Unreleased]: https://github.com/rokas-tarasevicius/session-analytics/compare/v1.2.3...HEAD\n[1.2.3]: https://github.com/rokas-tarasevicius/session-analytics/compare/v1.2.2...v1.2.3\n";
  const metadata = {
    packageVersion: "1.2.3", lockVersion: "1.2.3", lockRootVersion: "1.2.3", sourceVersion: "1.2.3",
    changelog: `# Changelog\n\n## [Unreleased]\n\n- Pending.\n\n## [1.2.3] - 2026-10-13\n\n### Changed\n\n- Current notes.\n\n## [1.2.2]\n\n- Older notes.\n\n${links}`,
  };
  assert.equal(extractReleaseNotes(metadata, "v1.2.3"), "### Changed\n\n- Current notes.\n");
  assert.equal(extractReleaseNotes({ ...metadata, changelog: `## [1.2.3]\n\n- Only release.\n\n${links}` }, "v1.2.3"), "- Only release.\n", "link definitions are not notes");
  for (const tag of ["v1.2.2", "v9.9.9", "v1.2", "1.2.3", "v1.2.3-beta.1"]) assert.throws(() => extractReleaseNotes(metadata, tag), /Release tag must be/);
  for (const field of ["packageVersion", "lockVersion", "lockRootVersion"] as const) assert.throws(() => checkReleaseMetadata({ ...metadata, [field]: "1.2.2" }), /does not match source/);
  assert.throws(() => checkReleaseMetadata({ ...metadata, changelog: "## [1.2.2]\n- Old" }), /Latest changelog/);
  assert.throws(() => extractReleaseNotes({ ...metadata, changelog: `## [1.2.3]\n\n### Changed\n\n${links}` }, "v1.2.3"), /no release notes/);
  assert.throws(() => checkReleaseMetadata({ ...metadata, changelog: metadata.changelog.replace("v1.2.3...HEAD", "v1.2.2...HEAD") }), /link \[Unreleased\]/);
  assert.throws(() => checkReleaseMetadata({ ...metadata, changelog: metadata.changelog.replace(/^\[1\.2\.3\]: .*\n/m, "") }), /link \[1\.2\.3\]/);
  assert.throws(() => checkReleaseMetadata({ ...metadata, changelog: metadata.changelog.replace("v1.2.2...v1.2.3", "v1.2.2...HEAD") }), /link \[1\.2\.3\]/);
});

test("release: the compiled package carries workers, served files and notices, and installs without running anything", { timeout: 120_000 }, async () => {
  const out = await mkdtemp(join(tmpdir(), "session-analytics-build-"));
  try {
    build(out);
    await writeFile(join(out, "src/stale-private.json"), "PRIVATE_OLD_BUILD_SENTINEL");
    build(out);
    assert.equal((await readdir(join(out, "src"))).includes("stale-private.json"), false, "rebuilding removes files from the previous output");
    // Every non-TypeScript file under src ships verbatim, including ones a module reads at run time without importing.
    const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
    for (const entry of await readdir(sourceRoot, { recursive: true, withFileTypes: true })) {
      const path = relative(sourceRoot, join(entry.parentPath, entry.name));
      if (!entry.isFile() || path.endsWith(".ts") || path.split(sep).some((part) => part.startsWith("."))) continue;
      assert.deepEqual(await readFile(join(out, "src", path)), await readFile(join(sourceRoot, path)), `src/${path} ships verbatim`);
    }
    const result = spawnSync("npm", ["pack", out, "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    const files: string[] = JSON.parse(result.stdout)[0].files.map((file: { path: string }) => file.path);
    checkPackageFiles(files);
    for (const extra of [".env", "src/.env", "data/sessions.jsonl", "data/local.sqlite", "test/fixtures.ts", "assets/private.png", "src/../secret.ts",
      "src/analyzer.ts", "src/public/format.d.ts", "src/server.js.map", "bin/session-analytics.ts", ".DS_Store"]) {
      assert.throws(() => checkPackageFiles([...files, extra]), /Unexpected package file/, extra);
    }
    for (const missing of ["src/analysis-worker.js", "src/cursor-worker.js", "src/mcp/worker.js", "src/remote/bootstrap.js", "src/public/machines.js", "src/public/fonts/OFL-1.1.txt", "src/public/subscription.css", "CHANGELOG.md"]) {
      assert.throws(() => checkPackageFiles(files.filter((path) => path !== missing)), /Package is missing/, missing);
    }
    const manifest = JSON.parse(await readFile(join(out, "package.json"), "utf8")) as Record<string, unknown>;
    const binSource = await readFile(join(out, "bin/session-analytics.js"), "utf8");
    checkPackageManifest(manifest, binSource, version);
    for (const [field, value] of [["scripts", { postinstall: "x" }], ["dependencies", { left: "1" }], ["private", true], ["version", "0.0.1"], ["bin", { "session-analytics": "bin/session-analytics.ts" }], ["os", ["darwin"]]] as const) {
      assert.throws(() => checkPackageManifest({ ...manifest, [field]: value }, binSource, version), Error, field);
    }
    assert.throws(() => checkPackageManifest(manifest, binSource.replace("#!/usr/bin/env node\n", ""), version), /#!\/usr\/bin\/env node/);
    const root = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as Record<string, unknown>;
    assert.equal(root["private"], true, "the TypeScript source layout can never be published by accident");
    assert.equal(root["version"], manifest["version"]);
  } finally { await rm(out, { recursive: true, force: true }); }
});

test("release: every dispatcher command shares help and version without scanning", () => {
  for (const command of ["dashboard", "report", "rates", "export", "merge", "index", "mcp", "limits", "machines", "upgrade"]) {
    const help = spawnSync(process.execPath, ["bin/session-analytics.ts", command, "--help"], { encoding: "utf8" });
    assert.equal(help.status, 0, `${command}: ${help.stderr}`); assert.match(help.stdout, /session-analytics/i);
    const result = spawnSync(process.execPath, ["bin/session-analytics.ts", command, "--version"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), version);
  }
  // Removed commands and options fail as unknown instead of being silently accepted.
  for (const command of ["insights", "review"]) assert.equal(spawnSync(process.execPath, ["bin/session-analytics.ts", command, "--help"], { encoding: "utf8" }).status, 2, command);
  for (const flag of ["--reliability-content-rules", "--outcomes-git", "--outcomes-github", "--workflow-content-rules", "--insights-config"]) {
    assert.equal(spawnSync(process.execPath, ["bin/session-analytics.ts", "report", flag, ...(flag === "--insights-config" ? ["x"] : [])], { encoding: "utf8" }).status, 2, flag);
  }
});

test("release: complete demo API, all providers and renderers, static modules and privacy work together", { timeout: 240_000 }, async (t) => {
  const listener = createServer(); await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address(); assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const base = `http://127.0.0.1:${address.port}`;
  // Discard unused progress output so an unread pipe cannot block demo startup.
  const child = spawn(process.execPath, ["scripts/demo.ts", "--no-open", "--port", String(address.port)], { stdio: ["ignore", "ignore", "pipe"] });
  let errors = ""; child.stderr.on("data", (chunk) => { errors += String(chunk); });
  const globals = globalThis as unknown as Record<string, any>;
  const originals = Object.fromEntries(["document", "window", "Option", "HTMLElement", "fetch"].map((key) => [key, globals[key]]));
  const realFetch = fetch;
  try {
    let ready = false;
    // Seeding seven providers includes many SQLite commits and can exceed 20 seconds on a busy filesystem.
    for (let i = 0; i < 1_500; i++) {
      assert.equal(child.exitCode, null, errors);
      try { ready = (await realFetch(`${base}/api/health`)).ok; } catch { /* Starting. */ }
      if (ready) break; await delay(100);
    }
    assert.ok(ready, "Demo server did not start");
    const response = await realFetch(`${base}/api/analytics`); assert.equal(response.status, 200, await response.clone().text());
    const raw = await response.text(); assert.doesNotMatch(raw, forbidden);
    const snapshot = validateSnapshot(JSON.parse(raw));
    assert.ok(snapshot.sessions.length > 100); assert.ok(snapshot.repositories.length >= 6);
    for (const provider of ["claude", "codex", "cursor", "copilot", "opencode", "gemini", "antigravity"]) assert.ok(snapshot.sessions.some((s) => s.provider === provider), provider);
    for (const key of ["velocity", "historyProfile", "mcpEvidence"] as const) assert.ok(snapshot.sessions.some((s) => s[key]), key);
    assert.ok(snapshot.spendByModel.some((m) => m.pricing?.length));
    const refreshed = await realFetch(`${base}/api/analytics?refresh=1`);
    assert.equal(refreshed.status, 200);
    const warm = validateSnapshot(await refreshed.json());
    assert.deepEqual(warm.sessions, snapshot.sessions, "warm demo replays every provider and namespace");
    // Cover the exact server allowlist, including modules imported transitively by views.
    const assets = staticRoutes.map(([route]) => route);
    for (const asset of ["/export-data.js", "/chart-colors.js", "/chart-legend.js", "/chart-scale.js"]) assert.ok(assets.includes(asset), asset);
    for (const asset of assets) { const r = await realFetch(base + asset); assert.equal(r.status, 200, asset); assert.ok((await r.arrayBuffer()).byteLength, asset); }
    const html = await (await realFetch(base)).text();
    const document = documentFromHtml(html), storage = { getItem: () => null, setItem() {} };
    const window = { matchMedia: () => ({ matches: false, addEventListener() {} }), localStorage: storage, setTimeout, clearTimeout, innerWidth: 1440 };
    const boundFetch = (url: string | URL, init?: RequestInit) => realFetch(new URL(String(url), base), init);
    Object.assign(globals, { document, window, Option, HTMLElement: Element, fetch: boundFetch });
    const app = await readFile(new URL("../src/public/app.js", import.meta.url), "utf8");
    const helpers: Record<string, any> = {};
    for (const [, specifiers, path] of app.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*["']([^"']+)["'];/g)) {
      const exports = await import(new URL(`../src/public/${path!.replace(/^\.\//, "")}`, import.meta.url).href);
      for (const name of specifiers!.split(",").map((s) => s.trim()).filter(Boolean)) helpers[name] = exports[name];
    }
    const source = app.replace(/^import[\s\S]*?from ["'][^"']+["'];\n/gm, "").split("const urlParameters =")[0]!;
    const context = { ...helpers, document, window, HTMLElement: Element, Option, URLSearchParams, localStorage: storage, fetch: boundFetch,
      setTimeout, clearTimeout, resetExportMenu: () => {}, fixture: snapshot, CSS: { escape: (s: string) => s } };
    const api = runInNewContext(source + `\nsnapshot = fixture; sessionsByRepository = groupByRepository(snapshot.sessions);
      elements.repositoryFilter.value = 'all';
      elements.windowStart.value = elements.windowStart.min = '2026-01-01'; elements.windowEnd.value = elements.windowEnd.max = snapshot.generatedAt.slice(0,10);
      applyUrlAfterRender = () => {};
      ({ switchView, activeView, paletteItems, viewChords, viewOrder, renderSharedView });`, context);
    assert.deepEqual([...api.viewOrder], views);
    assert.equal(new Set(Object.values(api.viewChords)).size, views.length);
    assert.equal(document.querySelectorAll("[data-view-button]").length, views.length);
    assert.equal(api.paletteItems().filter((i: any) => i.group === "Views").length, views.length);
    assert.deepEqual([...api.paletteItems()].filter((i: any) => i.group === "Views").map((i: any) => i.keywords), views.map((view) => `view ${view}`));
    for (const view of views) {
      api.switchView(view);
      assert.equal(document.querySelector("#page-title")!.textContent.trim().length > 0, true, view);
      assert.equal(document.querySelector(`[data-view-panel="${view}"]`)!.hidden, false, view);
      const rendered = document.body.textContent;
      assert.doesNotMatch(rendered, forbidden, view); assert.doesNotMatch(rendered, /NaN|Infinity/, view);
    }
    t.diagnostic(JSON.stringify({ sessions: snapshot.sessions.length, repositories: snapshot.repositories.length, views: views.length, staticAssets: assets.length, bytes: Buffer.byteLength(raw) }));
  } finally {
    for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globals[key]; else globals[key] = value; }
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await Promise.race([exited, delay(5000)]); }
  }
});
