#!/usr/bin/env node
/** Keep repository-discovery fixtures outside the developer's Git trees. */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function outsideGit(path: string): boolean {
  for (let current = realpathSync(path); ; current = dirname(current)) {
    if (existsSync(join(current, ".git"))) return false;
    if (dirname(current) === current) return true;
  }
}

function temporaryDirectory(): string {
  const candidates = [...new Set([tmpdir(), ...(process.platform === "win32" ? [] : ["/var/tmp"])])];
  for (const candidate of candidates) {
    try {
      if (outsideGit(candidate)) return mkdtempSync(join(candidate, "session-analytics-tests-"));
    } catch { /* Try the next writable system temporary directory. */ }
  }
  throw new Error("Tests need a writable temporary directory outside any Git repository. Set TMPDIR to one.");
}

function testFiles(directory: string): string[] {
  return readdirSync(join(root, directory)).filter((name) => /\.test\.(?:ts|mjs)$/.test(name)).map((name) => join(directory, name));
}

const browserOnly = process.argv[2] === "--browser";
const files = browserOnly ? ["test/dashboard.browser.test.ts"] : [
  ...testFiles("test"), ...testFiles("test/validation"),
  ...readdirSync(join(root, "verify"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => testFiles(join("verify", entry.name))),
].sort();
const temporary = temporaryDirectory();
const child = spawn(process.execPath, ["--test", "--test-concurrency=2", ...process.argv.slice(browserOnly ? 3 : 2), ...files], {
  cwd: root, stdio: "inherit", env: {
    ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    ...(browserOnly ? { SESSION_ANALYTICS_REQUIRE_BROWSER: "1" } : {}),
  },
});
const interrupt = () => child.kill("SIGINT");
const terminate = () => child.kill("SIGTERM");
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);
child.once("error", () => {
  process.stderr.write("Could not start the Node test runner.\n");
  process.exitCode = 1;
});
child.once("close", (code, signal) => {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", terminate);
  rmSync(temporary, { recursive: true, force: true });
  process.exitCode = code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
});
