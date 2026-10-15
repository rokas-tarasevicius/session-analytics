import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, relative, sep } from "node:path";
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
/** Evaluate a job's `if:` as GitHub would for given results; the gates use only ==, &&, ||, !, cancelled() and contains(). */
function gate(job: string): (context: { needs: Record<string, string>, vars?: Record<string, string>, ref?: string, cancelled?: boolean }) => boolean {
  const expression = /^    if: \$\{\{ (.*) \}\}$/m.exec(job)?.[1];
  assert.ok(expression, "publishing jobs state their gate");
  const evaluate = new Function("needs", "vars", "github", "cancelled", "contains", `return ${expression};`);
  return ({ needs, vars = {}, ref = "v1.2.3", cancelled = false }) => evaluate(Object.fromEntries(Object.entries(needs).map(([name, result]) => [name, { result }])), vars,
    { ref_name: ref }, () => cancelled, (text: string, part: string) => text.includes(part));
}
const results = ["success", "failure", "skipped", "cancelled"];

test("release: every workflow action is pinned to a full commit SHA", async () => {
  for (const name of ["ci.yml", "release.yml"]) {
    const workflow = await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");
    const uses = [...workflow.matchAll(/^\s+(?:- )?uses: (.+)$/gm)].map((match) => match[1]!);
    assert.ok(uses.length > 0, name);
    for (const action of uses) assert.match(action, /^actions\/[a-z-]+@[0-9a-f]{40} # v\d+(?:\.\d+)*$/, `${name}: ${action}`);
    assert.doesNotMatch(workflow, /agentbox|self-hosted|repository\.private|continue-on-error|pull_request_target/, name);
  }
});

test("release: a tag publishes only the validated, smoke-tested tarball, in order", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.match(workflow, /on:\n  push:\n    tags: \['v\*'\]/);
  assert.match(workflow, /\npermissions:\n  contents: read\n/);
  assert.match(workflow, /concurrency:\n  group: release-.*\n  cancel-in-progress: false/);
  const jobs = workflowJobs(workflow);
  assert.deepEqual(Object.keys(jobs), ["validate", "browser", "package", "smoke", "release", "npm", "homebrew"]);
  const { validate, browser, package: pack, smoke, release, npm, homebrew } = jobs as Record<string, string>;

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

  assert.deepEqual(/^        os: \[([^\]]+)\]$/m.exec(validate!)?.[1]!.split(", "), ["ubuntu-latest", "macos-latest"]);
  assert.match(validate!, /name: release validation \(\$\{\{ matrix.os \}\}\)/);
  assert.match(validate!, /run: node scripts\/release-check.ts --notes "\$GITHUB_REF_NAME"/);
  assert.match(validate!, /run: npm run release:check/);
  assert.match(browser!, /name: release browser \(ubuntu-latest\)/);
  assert.doesNotMatch(browser!, /^    if:/m, "tag browser checks cannot be skipped");
  assert.match(browser!, /SESSION_ANALYTICS_REQUIRE_BROWSER: '1'/);
  assert.match(pack!, /run: npm ci/);
  assert.match(pack!, /run: node scripts\/release-check.ts --notes "\$GITHUB_REF_NAME"/);
  assert.match(pack!, /npm run pack:release\n.*release\/session-analytics\.tgz\n.*sha256sum .* > SHA256SUMS/);
  assert.match(pack!, /uses: actions\/upload-artifact@/);
  assert.deepEqual(needsOf(smoke!), ["package"]);
  assert.deepEqual(/^        os: \[([^\]]+)\]$/m.exec(smoke!)?.[1]!.split(", "), ["ubuntu-latest", "macos-latest"]);
  assert.deepEqual(/^        node: \[([^\]]+)\]$/m.exec(smoke!)?.[1]!.split(", "), ["'24.0.0'", "'24'", "'26'"], "the engines floor, the newest 24.x and Homebrew's Node.js");
  assert.match(smoke!, /run: node scripts\/smoke-installed.ts "release\/session-analytics-\$\{GITHUB_REF_NAME#v\}.tgz"/);
  assert.doesNotMatch(smoke!, /npm ci|npm run/, "the smoke runs the packed tarball, not a fresh build");

  // Every consumer of the packed files checks them against SHA256SUMS before using them.
  for (const [name, job, use] of [["smoke", smoke, "scripts/smoke-installed.ts"], ["release", release, "attest-build-provenance"], ["npm", npm, "npm publish"], ["homebrew", homebrew, "scripts/homebrew-formula.ts"]] as const) {
    const download = job!.indexOf("uses: actions/download-artifact@"), verified = job!.indexOf("-c SHA256SUMS");
    assert.ok(download > 0 && verified > download && job!.indexOf(use) > verified, `${name} verifies checksums before ${use}`);
  }

  // Nothing publishes unless validation, the browser check, packaging and every installed smoke succeeded.
  assert.deepEqual(needsOf(release!), ["validate", "browser", "package", "smoke"]);
  const canRelease = gate(release!);
  for (const validated of results) for (const browsed of results) for (const packed of results) for (const smoked of results) {
    const needs = { validate: validated, browser: browsed, package: packed, smoke: smoked };
    assert.equal(canRelease({ needs }), Object.values(needs).every((result) => result === "success"), JSON.stringify(needs));
    assert.equal(canRelease({ needs, cancelled: true }), false, "a cancelled workflow never publishes");
  }
  const upstream = (name: string): string[] => needsOf(jobs[name]!).flatMap((need) => [need, ...upstream(need)]);
  for (const name of ["release", "npm", "homebrew"]) for (const required of ["validate", "browser", "package", "smoke"]) assert.ok(upstream(name).includes(required), `${name} needs ${required}`);

  // The release job runs no repository code; files reach a draft before it is published as the latest release.
  assert.doesNotMatch(release!, /actions\/checkout|npm ci|npm run|scripts\//);
  const order = ["-c SHA256SUMS", "attest-build-provenance", "draft: true", "upload_url", "draft: false"].map((step) => release!.indexOf(step));
  assert.ok(order.every((index, position) => index > 0 && (position === 0 || index > order[position - 1]!)), `release order ${order}`);
  assert.match(release!, /subject-path: release\/session-analytics-\*\.tgz/);
  assert.match(release!, /make_latest: makeLatest \? 'true' : 'false'/);
  for (const asset of ["`session-analytics-${version}.tgz`", "'session-analytics.tgz'", "'SHA256SUMS'"]) assert.ok(release!.includes(asset), asset);

  // npm and Homebrew follow the GitHub Release and stay off until their one-time setup sets a repository variable.
  assert.deepEqual(needsOf(npm!), ["release"]);
  const canPublishNpm = gate(npm!);
  for (const released of results) for (const flag of ["true", "false", "", undefined]) {
    const vars: Record<string, string> = flag === undefined ? {} : { NPM_PUBLISH: flag };
    assert.equal(canPublishNpm({ needs: { release: released }, vars }), released === "success" && flag === "true", `release=${released}, NPM_PUBLISH=${flag}`);
    assert.equal(canPublishNpm({ needs: { release: released }, vars, cancelled: true }), false);
  }
  const [major, minor, patch] = /npm install --global npm@(\d+)\.(\d+)\.(\d+)\n/.exec(npm!)?.slice(1).map(Number) ?? [];
  assert.ok(major !== undefined && minor !== undefined && patch !== undefined, "npm is pinned to an exact version");
  assert.ok(major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1))), "trusted publishing needs npm 11.5.1 or newer");
  assert.match(npm!, /registry-url: https:\/\/registry\.npmjs\.org/);
  assert.match(npm!, /npm publish "release\/session-analytics-\$V\.tgz" --tag "\$DIST_TAG"/);
  const [published, verified, installed] = ["npm publish", "dist.integrity 2>/dev/null || true", "scripts/smoke-installed.ts \"session-analytics@"].map((step) => npm!.indexOf(step));
  assert.ok(published! > 0 && verified! > published! && installed! > verified!, "npm checks the registry integrity, then installs the registry version and runs it");
  assert.deepEqual(needsOf(homebrew!), ["release", "npm"]);
  const canUpdateTap = gate(homebrew!);
  for (const released of results) for (const npmResult of results) for (const flag of ["true", ""]) for (const ref of ["v1.2.3", "v1.3.0-rc.1"]) {
    const expected = released === "success" && (npmResult === "success" || npmResult === "skipped") && flag === "true" && !ref.includes("-");
    assert.equal(canUpdateTap({ needs: { release: released, npm: npmResult }, vars: { HOMEBREW_TAP: flag }, ref }), expected, `release=${released}, npm=${npmResult}, HOMEBREW_TAP=${flag}, ${ref}`);
  }
  assert.match(homebrew!, /node scripts\/homebrew-formula.ts --version "\$V" --sha256 /);
  assert.match(homebrew!, /^    runs-on: macos-latest$/m, "Homebrew installs and tests the formula before the tap receives it");
  const tapOrder = ["scripts/homebrew-formula.ts", "brew install --formula", "brew test", "brew audit --strict", "contents/Formula/session-analytics.rb"].map((step) => homebrew!.indexOf(step));
  assert.ok(tapOrder.every((index, position) => index > 0 && (position === 0 || index > tapOrder[position - 1]!)), `homebrew order ${tapOrder}`);
  assert.match(homebrew!, /repos\/rokas-tarasevicius\/homebrew-tap\/contents\/Formula\/session-analytics\.rb/);
  assert.match(homebrew!, /TAP_TOKEN: \$\{\{ secrets.TAP_TOKEN \}\}/);
});

/** A step's `run:` script, dedented; for an inline `node <<'NODE'` script, the script alone. */
function stepScript(job: string, name: string): string {
  const step = job.split(/^      - name: /m).find((candidate) => candidate.startsWith(`${name}\n`));
  assert.ok(step, name);
  const block = /^        run: \|\n((?:(?: {10}.*)?\n)+)/m.exec(step)?.[1];
  assert.ok(block, `${name} runs a script`);
  const script = block.split("\n").map((line) => line.slice(10)).join("\n");
  return /<<'NODE'\n([\s\S]*?)\nNODE\n/.exec(script)?.[1] ?? script;
}

/** Run a workflow's inline Node script against canned GitHub API replies; returns the API calls it made. */
async function runAgainstApi(script: string, directory: string, routes: Record<string, { status: number, json?: unknown }>, env: Record<string, string>): Promise<Array<{ method: string, path: string, body?: any }>> {
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
  assert.equal(result.status, 0, result.stderr);
  return (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}

test("release: a tag published after a newer release never moves GitHub, npm or Homebrew back to it", async () => {
  const { release, npm, homebrew } = workflowJobs(await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")) as Record<string, string>;
  const directory = await mkdtemp(join(tmpdir(), "session-analytics-latest-"));
  try {
    await mkdir(join(directory, "release"));
    for (const name of ["session-analytics-1.9.0.tgz", "session-analytics.tgz", "SHA256SUMS"]) await writeFile(join(directory, "release", name), `${name} bytes\n`);
    await writeFile(join(directory, "notes.md"), "- Notes.\n");
    const publishRelease = stepScript(release!, "Publish GitHub Release");
    for (const [latest, expected] of [["v1.10.0", "false"], ["v1.9.1", "false"], ["v1.8.7", "true"], [null, "true"]] as const) {
      const calls = await runAgainstApi(publishRelease, directory, {
        "GET /repos/o/r/releases?per_page=100&page=1": { status: 200, json: [] },
        "POST /repos/o/r/releases": { status: 201, json: { id: 7, assets: [], upload_url: "https://uploads.github.com/repos/o/r/releases/7/assets{?name,label}" } },
        "PATCH /repos/o/r/releases/7": { status: 200, json: { id: 7 } },
        ...(latest ? { "GET /repos/o/r/releases/latest": { status: 200, json: { tag_name: latest } } } : {}),
      }, { GITHUB_REF_NAME: "v1.9.0", GITHUB_REPOSITORY: "o/r", GH_TOKEN: "token" });
      assert.deepEqual(calls.at(-1), { method: "PATCH", path: "/repos/o/r/releases/7", body: { draft: false, make_latest: expected } }, `latest ${latest}`);
    }

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
        cwd: directory, encoding: "utf8", env: { PATH: `${bin}${delimiter}${process.env["PATH"]}`, GITHUB_REF_NAME: tag, MOCK_LOG: log, MOCK_LATEST: latest },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal((await readFile(log, "utf8")).trim().split("\n").at(-1), `publish release/session-analytics-${tag.slice(1)}.tgz --tag ${expected}`, `${tag} after ${latest || "none"}`);
    }

    // Homebrew: never replace a newer formula, and make no commit for an identical one.
    const commitFormula = stepScript(homebrew!, "Commit the formula to the tap");
    const sha256 = "0123456789abcdef".repeat(4), path = "/repos/rokas-tarasevicius/homebrew-tap/contents/Formula/session-analytics.rb";
    await writeFile(join(directory, "session-analytics.rb"), homebrewFormula("1.9.0", sha256));
    for (const [tapped, commits] of [["1.10.0", false], ["1.9.0", false], ["1.8.7", true], [null, true]] as const) {
      const calls = await runAgainstApi(commitFormula, directory, {
        ...(tapped ? { [`GET ${path}?ref=main`]: { status: 200, json: { sha: "tap-sha", content: Buffer.from(homebrewFormula(tapped, sha256)).toString("base64") } } } : {}),
        [`PUT ${path}`]: { status: 200, json: {} },
      }, { GITHUB_REF_NAME: "v1.9.0", TAP_TOKEN: "token" });
      const put = calls.find((call) => call.method === "PUT");
      assert.equal(Boolean(put), commits, `tap at ${tapped}`);
      if (put) assert.equal(put.body.sha, tapped ? "tap-sha" : undefined);
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
  assert.match(formula, /^    env = \{ PATH: "#\{Formula\["node"\]\.opt_bin\}:\$PATH" \}\n    \(bin\/"session-analytics"\)\.write_env_script libexec\/"bin\/session-analytics", env$/m);
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
  for (const command of ["dashboard", "report", "rates", "export", "merge", "index", "mcp", "limits"]) {
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

test("release: complete demo API, all six renderers, static modules and privacy work together", { timeout: 120_000 }, async (t) => {
  const listener = createServer(); await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address(); assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const base = `http://127.0.0.1:${address.port}`;
  const child = spawn(process.execPath, ["scripts/demo.ts", "--no-open", "--port", String(address.port)], { stdio: ["ignore", "pipe", "pipe"] });
  let errors = ""; child.stderr.on("data", (chunk) => { errors += String(chunk); });
  const globals = globalThis as unknown as Record<string, any>;
  const originals = Object.fromEntries(["document", "window", "Option", "HTMLElement", "fetch"].map((key) => [key, globals[key]]));
  const realFetch = fetch;
  try {
    let ready = false;
    for (let i = 0; i < 200; i++) {
      assert.equal(child.exitCode, null, errors);
      try { ready = (await realFetch(`${base}/api/health`)).ok; } catch { /* Starting. */ }
      if (ready) break; await delay(100);
    }
    assert.ok(ready, "Demo server did not start");
    const response = await realFetch(`${base}/api/analytics`); assert.equal(response.status, 200, await response.clone().text());
    const raw = await response.text(); assert.doesNotMatch(raw, forbidden);
    const snapshot = validateSnapshot(JSON.parse(raw));
    assert.ok(snapshot.sessions.length > 100); assert.ok(snapshot.repositories.length >= 6);
    for (const provider of ["claude", "codex", "cursor", "copilot", "opencode", "gemini"]) assert.ok(snapshot.sessions.some((s) => s.provider === provider), provider);
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
