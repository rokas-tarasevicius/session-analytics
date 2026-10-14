import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, checkEmitted, checkOutput, packageManifest, typeScriptReferences } from "../scripts/build.ts";
import { loadSnapshot } from "../src/mcp/snapshot.ts";
import { moduleUrl } from "../src/module-url.ts";
import { indexErrorCode, workerExitMessage } from "../src/store/errors.ts";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));

test("packaging: moduleUrl names .ts siblings from source and .js siblings from the compiled package", () => {
  assert.equal(moduleUrl("./analysis-worker.ts", "file:///repo/src/analysis-process.ts").href, "file:///repo/src/analysis-worker.ts");
  assert.equal(moduleUrl("./analysis-worker.ts", "file:///pkg/src/analysis-process.js").href, "file:///pkg/src/analysis-worker.js");
  assert.equal(moduleUrl("../analyzer.ts", "file:///a%20b/src/store/index.js").href, "file:///a%20b/src/analyzer.js");
  assert.equal(moduleUrl("../../schemas/snapshot.v1.schema.json", "file:///pkg/src/store/index.js").href, "file:///pkg/schemas/snapshot.v1.schema.json");
});

test("packaging: every runtime moduleUrl target exists in the source tree", async () => {
  const files = (await readdir(sourceRoot, { recursive: true })).filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"));
  const targets: string[] = [];
  for (const file of files) {
    const source = await readFile(join(sourceRoot, file), "utf8");
    for (const [, specifier] of source.matchAll(/moduleUrl\(\s*"([^"]+)"/g)) {
      targets.push(specifier!);
      assert.ok(existsSync(fileURLToPath(moduleUrl(specifier!, pathToFileURL(join(sourceRoot, file)).href))), `${file}: ${specifier}`);
    }
    // A worker or fingerprint path written as new URL("./x.ts") would break only in the compiled package; imports are rewritten.
    assert.doesNotMatch(source, /(?:new URL|readFileSync|readFile)\(\s*["'`][^"'`]+\.ts["'`]/, file);
  }
  for (const worker of ["./analysis-worker.ts", "./cursor-worker.ts", "./worker.ts"]) assert.ok(targets.includes(worker), worker);
});

test("packaging: SQL names no ?NNN parameter, which Node.js 24.0 to 24.6 cannot bind positionally", async () => {
  for (const file of (await readdir(sourceRoot, { recursive: true })).filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"))) {
    assert.doesNotMatch(await readFile(join(sourceRoot, file), "utf8"), /(?:=|\(|,)\s*\?\d+\b/, file);
  }
});

test("packaging: the build guard finds runtime .ts references and missing moduleUrl targets, not JSDoc types", async () => {
  assert.deepEqual(typeScriptReferences('spawn(node, [fileURLToPath(new URL("./worker.ts", import.meta.url))]);'), ["./worker.ts"]);
  assert.deepEqual(typeScriptReferences('await import("../src/cli.ts"); readFileSync("./a.ts"); readFile(`./b.ts`)'), ["../src/cli.ts", "./a.ts", "./b.ts"]);
  assert.deepEqual(typeScriptReferences('/** @param {import("../types.ts").SessionAnalytics} session */\nmoduleUrl("./worker.ts", import.meta.url);'), []);
  const out = await mkdtemp(join(tmpdir(), "session-analytics-emitted-"));
  try {
    await mkdir(join(out, "bin")); await mkdir(join(out, "src", "mcp"), { recursive: true });
    await writeFile(join(out, "bin", "session-analytics.js"), 'await import("../src/cli.js");\n');
    await writeFile(join(out, "src", "mcp", "snapshot.js"), 'const script = moduleUrl("./worker.ts", import.meta.url);\n');
    await writeFile(join(out, "src", "analyzer.js"), 'spawn(process.execPath, [fileURLToPath(new URL("./cursor-worker.ts", import.meta.url))]);\n');
    assert.deepEqual(checkEmitted(out).sort(), ["src/analyzer.js still names ./cursor-worker.ts", "src/mcp/snapshot.js runs missing ./worker.js"]);
    await writeFile(join(out, "src", "mcp", "worker.js"), "");
    await writeFile(join(out, "src", "analyzer.js"), 'spawn(process.execPath, [fileURLToPath(moduleUrl("./cursor-worker.ts", import.meta.url))]);\n');
    await writeFile(join(out, "src", "cursor-worker.js"), "");
    assert.deepEqual(checkEmitted(out), []);
    // A file read through new URL() ships only if the build copied it; directory URLs and comments are not files.
    await mkdir(join(out, "src", "remote"));
    await writeFile(join(out, "src", "remote", "runtime.js"), 'const bootstrap = readFileSync(fileURLToPath(new URL("./bootstrap.js", import.meta.url)));\n' +
      'const installRoot = new URL("../../", import.meta.url);\nconst schema = new URL("../../schemas/snapshot.v1.schema.json", import.meta.url);\n/** new URL("./example.txt", import.meta.url) */\n');
    assert.deepEqual(checkEmitted(out).sort(), ["src/remote/runtime.js reads missing ../../schemas/snapshot.v1.schema.json", "src/remote/runtime.js reads missing ./bootstrap.js"]);
    await mkdir(join(out, "schemas"));
    await writeFile(join(out, "schemas", "snapshot.v1.schema.json"), "{}");
    await writeFile(join(out, "src", "remote", "bootstrap.js"), "");
    assert.deepEqual(checkEmitted(out), []);
  } finally { await rm(out, { recursive: true, force: true }); }
});

test("packaging: the build empties only a new, empty or earlier build directory, never the checkout, home or other files", async () => {
  const checkout = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
  const scratch = await mkdtemp(join(tmpdir(), "session-analytics-out-"));
  const home = join(scratch, "home"), work = join(scratch, "work"), earlier = join(scratch, "earlier"), sentinel = join(work, "keep", "sentinel.txt");
  try {
    await mkdir(join(work, "keep"), { recursive: true }); await mkdir(home); await mkdir(earlier); await mkdir(join(scratch, "empty"));
    await writeFile(sentinel, "keep me");
    await writeFile(join(earlier, "package.json"), JSON.stringify(packageManifest({ name: "session-analytics", version: "1.2.3" })));
    await writeFile(join(earlier, "stale.js"), "");
    for (const out of [join(checkout, "dist"), join(scratch, "new"), join(scratch, "empty"), earlier]) assert.doesNotThrow(() => checkOutput(out, home), out);
    for (const out of [checkout, dirname(checkout), "/", home, scratch]) assert.throws(() => checkOutput(out, home), /contains this checkout or your home/, out);
    for (const out of [join(checkout, "src"), work]) assert.throws(() => checkOutput(out, home), /holds no earlier build/, out);
    assert.throws(() => checkOutput(sentinel, home), /not a directory/);
    await writeFile(join(earlier, "package.json"), JSON.stringify({ ...packageManifest({ name: "session-analytics" }), scripts: { build: "x" } }));
    assert.throws(() => checkOutput(earlier, home), /holds no earlier build/, "the source manifest has scripts");
    assert.throws(() => build(work), /holds no earlier build/);
    assert.equal(await readFile(sentinel, "utf8"), "keep me");
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("packaging: checkout baselines name the checkout bin, so an exported SESSION_ANALYTICS_DEMO_BIN cannot replace them", async () => {
  const demo = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/demo.ts", import.meta.url)), "report", "--json", "--bin", "/nonexistent/explicit-bin"],
    { encoding: "utf8", env: { ...process.env, SESSION_ANALYTICS_DEMO_BIN: fileURLToPath(new URL("../bin/session-analytics.ts", import.meta.url)) } });
  assert.equal(demo.status, 2, "--bin wins over the environment");
  assert.match(demo.stderr, /explicit-bin/);
  for (const script of ["smoke-installed.ts", "release-check.ts"]) {
    assert.match(await readFile(new URL(`../scripts/${script}`, import.meta.url), "utf8"), /"--bin", join\(root, "bin\/session-analytics\.ts"\)/, script);
  }
});

test("packaging: a worker that cannot start gets a fixed reason, never its stderr", async () => {
  const secret = "/Users/PRIVATE-SENTINEL/secret-repo/prompt.txt";
  assert.equal(workerExitMessage("", `node:internal/modules/run_main:123\nError: Cannot find module '${secret}'\n  code: 'MODULE_NOT_FOUND'`), "This session-analytics installation is incomplete: a module it runs is missing. Reinstall it.");
  assert.equal(workerExitMessage("", `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '${secret}' imported from ${secret}`), "This session-analytics installation is incomplete: a module it runs is missing. Reinstall it.");
  assert.equal(workerExitMessage("", "Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite"), "Session analysis needs Node.js 24 or newer with node:sqlite.");
  assert.match(workerExitMessage("", `Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is currently unsupported for files under node_modules, for "${secret}"`) ?? "", /cannot run TypeScript from node_modules/);
  assert.equal(workerExitMessage('{"analysisError":"index-busy"}', "Error [ERR_MODULE_NOT_FOUND]"), "The local index is busy; another ingest or maintenance command is running.", "the worker's own fixed code wins");
  for (const [output, stderr] of [["", "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory"], ['{"analysisError":"analysis-unavailable"}', secret], ['{"analysisErr', ""]]) {
    assert.equal(workerExitMessage(output!, stderr!), null);
  }
  // The message crosses a second process boundary as its code.
  assert.equal(indexErrorCode(new Error(workerExitMessage("", "MODULE_NOT_FOUND")!)), "install-incomplete");
  await assert.rejects(loadSnapshot({}, new AbortController().signal, { script: new URL("./missing-worker-PRIVATE-SENTINEL.ts", import.meta.url) }),
    (error: Error) => error.message === "This session-analytics installation is incomplete: a module it runs is missing. Reinstall it.");
});

test("packaging: the bin stops on Node.js older than 24 before loading any command", () => {
  const bin = fileURLToPath(new URL("../bin/session-analytics.ts", import.meta.url));
  const older = 'data:text/javascript,Object.defineProperty(process.versions,"node",{value:"22.9.0"});Object.defineProperty(process,"version",{value:"v22.9.0"});';
  for (const args of [["--version"], ["report", "--json"], ["mcp"]]) {
    const result = spawnSync(process.execPath, ["--import", older, bin, ...args], { cwd: dirname(bin), encoding: "utf8", input: "" });
    assert.equal(result.status, 1, args.join(" "));
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Session Analytics needs Node.js 24 or newer; this is v22.9.0.\n");
  }
});
