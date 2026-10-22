import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createSessionAnalyticsFixture } from "./fixtures.ts";

/** Exercise Node's HTTP parser too; fetch normalizes paths and request framing. */
async function rawHttp(port: number, message: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let response = "";
    socket.setEncoding("utf8");
    socket.setTimeout(5_000, () => socket.destroy(new Error("HTTP probe timed out.")));
    socket.on("connect", () => socket.write(message));
    socket.on("data", (chunk: string) => { response += chunk; });
    socket.on("error", reject);
    socket.on("close", () => resolve(response));
  });
}

function assertPrivateRejection(response: string, status: number): void {
  assert.match(response, new RegExp(`^HTTP/1\\.1 ${status} `));
  assert.match(response, /\r\nCache-Control: no-store\r\n/i);
  assert.match(response, /\r\nContent-Security-Policy: [^\r]*frame-ancestors 'none'/i);
  assert.match(response, /\r\nX-Content-Type-Options: nosniff\r\n/i);
  assert.match(response, /\r\nCross-Origin-Resource-Policy: same-origin\r\n/i);
  assert.match(response, /\r\nCross-Origin-Opener-Policy: same-origin\r\n/i);
  assert.match(response, /\r\nReferrer-Policy: no-referrer\r\n/i);
  assert.match(response, /\r\nX-Frame-Options: DENY\r\n/i);
  assert.match(response, /\r\nConnection: close\r\n/i);
  assert.doesNotMatch(response, /Access-Control-Allow-Origin|HTTP-PROBE-SENTINEL/i);
}

test("loopback HTTP input boundaries reject without content or refresh side effects", { timeout: 60_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "server-security-"));
  const fixture = await createSessionAnalyticsFixture(directory);
  const empty = join(directory, "empty");
  await mkdir(empty);
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/server.ts", import.meta.url)),
    "--port", String(port), "--no-open", "--offline", "--no-remote", "--no-index", "--no-additional-providers",
    "--data-dir", fixture.dataDir, "--claude-root", fixture.claudeRoot, "--codex-root", fixture.codexRoot,
    "--codex-archive-root", fixture.codexArchiveRoot, "--cursor-database", fixture.cursorDatabasePath,
    "--database", fixture.databasePath, "--cursor-sdk-root", empty, "--cursor-transcript-root", empty,
    "--copilot-root", empty, "--opencode-database", join(empty, "opencode.db"), "--gemini-root", empty,
    "--antigravity-root", empty,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += String(chunk); });
  try {
    const deadline = Date.now() + 20_000;
    while (!stdout.includes("Session Analytics ready:")) {
      assert.equal(child.exitCode, null, stderr);
      assert.ok(Date.now() < deadline, "Synthetic security server did not start.");
      await delay(25);
    }
    assert.equal((await fetch(`${origin}/api/analytics`)).status, 200);
    for (const [name, headers] of [
      ["HTTPS Origin on the HTTP host", { Origin: `https://127.0.0.1:${port}` }],
      ["Origin with credentials", { Origin: `http://HTTP-PROBE-SENTINEL@127.0.0.1:${port}` }],
      ["Origin with a path", { Origin: `${origin}/HTTP-PROBE-SENTINEL` }],
      ["Origin with a query", { Origin: `${origin}?HTTP-PROBE-SENTINEL` }],
      ["Origin with a fragment", { Origin: `${origin}#HTTP-PROBE-SENTINEL` }],
    ] as Array<[string, Record<string, string>]>) {
      await t.test(`API rejects ${name}`, async () => {
        for (const path of ["/api/analytics", "/api/analytics?refresh=1", "/api/health", "/api/machines", "/api/limits"]) {
          const response = await fetch(`${origin}${path}`, { headers });
          assert.equal(response.status, 403, path);
          assert.doesNotMatch(await response.text(), /HTTP-PROBE-SENTINEL/);
        }
      });
    }
    await t.test("GET bodies are rejected before refresh without reading the advertised bytes", async () => {
      const before = await (await fetch(`${origin}/api/analytics`)).text();
      for (const framing of [
        "Content-Length: 1000000000\r\n",
        "Transfer-Encoding: chunked\r\n",
        "Content-Length: 1\r\nExpect: 100-continue\r\n",
      ]) {
        const response = await rawHttp(port, `GET /api/analytics?refresh=1 HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${framing}\r\n`);
        assertPrivateRejection(response, 413);
        assert.doesNotMatch(response, /100 Continue|"sessions"|"pending"/);
      }
      const pipelined = await rawHttp(port, `GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n0\r\n\r\nGET /api/analytics?refresh=1&wait=0.001 HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
      assertPrivateRejection(pipelined, 413);
      assert.equal((pipelined.match(/HTTP\/1\.1 /g) ?? []).length, 1, "the rejected body connection is never reused");
      assert.equal(await (await fetch(`${origin}/api/analytics`)).text(), before, "neither rejected bodies nor trailing pipelined requests start a refresh");
      assert.equal((await fetch(`${origin}/api/health`, { headers: { "Content-Length": "0" } })).status, 200);
    });
    await t.test("long paths and query values have a bounded private rejection", async () => {
      const prefix = "/api/health?padding=";
      assert.equal((await fetch(origin + prefix + "a".repeat(8_192 - prefix.length))).status, 200);
      for (const path of [`/${"a".repeat(9_000)}`, `/api/health?HTTP-PROBE-SENTINEL=${"a".repeat(9_000)}`]) {
        const response = await rawHttp(port, `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
        assertPrivateRejection(response, 414);
      }
    });
    await t.test("unsupported methods and expectations reject without draining a body", async () => {
      for (const [method, extra, status] of [["POST", "", 405], ["GET", "Expect: HTTP-PROBE-SENTINEL\r\n", 417]] as const) {
        assertPrivateRejection(await rawHttp(port, `${method} /api/health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 1000000000\r\n${extra}\r\n`), status);
      }
    });
    await t.test("HTTP parser errors retain private security headers and never echo request bytes", async () => {
      for (const [line, extra, status] of [
        ["GET /api/health HTTP/1.1", `X-Probe: HTTP-PROBE-SENTINEL${"a".repeat(20_000)}\r\n`, 431],
        ["GET /api/health HTTP/1.1", "Content-Length: HTTP-PROBE-SENTINEL\r\n", 400],
        ["HTTP-PROBE-SENTINEL / HTTP/1.1", "", 400],
      ] as const) {
        assertPrivateRejection(await rawHttp(port, `${line}\r\nHost: 127.0.0.1:${port}\r\n${extra}\r\n`), status);
      }
      assert.equal((await fetch(`${origin}/api/health`)).status, 200);
    });

  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await Promise.race([exited, delay(5_000, undefined, { ref: false }).then(() => { child.kill("SIGKILL"); })]);
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
