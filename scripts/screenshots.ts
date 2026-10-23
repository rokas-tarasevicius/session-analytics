/**
 * Regenerates the README screenshots from a running demo dashboard.
 *
 *   npm run demo -- --no-open --port 4175            # terminal 1: synthetic data only
 *   node scripts/screenshots.ts --url http://127.0.0.1:4175   # terminal 2
 *
 * Options: --url URL (default http://127.0.0.1:4175), --out DIR (default assets),
 * --only NAME (one capture, both themes), --chrome PATH (or the CHROME environment variable).
 * Requires Google Chrome and `cwebp` or ImageMagick (`magick`) on PATH. Captures are 1280 CSS pixels wide at 2x, comfortable
 * density, in light and dark themes, written as lossless WebP to assets/screenshot-<name>[-dark].webp.
 * The mobile capture uses 375 × 812 CSS pixels, compact density, at the same 2x scale.
 * Point --url at the demo only: the captured page content is written to the repository.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Capture = {
  name: string;
  view: "summary" | "velocity" | "costs" | "pricing" | "subscription" | "tools" | "activity";
  query?: string;
  /** Expression that turns true once the view's own data has arrived (Subscription loads its meters separately). */
  waitJs?: string;
  /** Runs after the snapshot is live; `__p(title)` finds a panel by heading, `__rect(el)` returns [x, y, w, h]. */
  js?: string;
  /** Expression returning the bottom edge (CSS px) the viewport should end at. */
  fitJs?: string;
  /** Expression returning [x, y, w, h] to clip, in CSS px, with the whole page laid out. */
  clipJs?: string;
  pad?: number;
  width?: number;
  height?: number;
  density?: "compact" | "comfortable";
};

const panelBottom = (title: string): string => `(() => { const r = __rect(__p(${JSON.stringify(title)})); return r[1] + r[3]; })()`;
const span = (first: string, last: string): string =>
  `(() => { const a = __rect(${first}), b = __rect(${last}); return [a[0], a[1], b[0] + b[2] - a[0], b[1] + b[3] - a[1]]; })()`;

const CAPTURES: Capture[] = [
  { name: "summary", view: "summary", fitJs: "Math.max(...['Window totals', 'Daily usage value', 'Sessions by provider'].map((title) => { const r = __rect(__p(title)); return r[1] + r[3]; }))" },
  { name: "summary-breakdowns", view: "summary", clipJs: span("__p('Usage value by repository')", "__p('Sub-agent value')"), pad: 14 },
  { name: "repository", view: "summary", query: "&repo=data-pipeline", clipJs: span("__p('Usage value by provider')", "document.querySelector('#repository-comparison')"), pad: 14 },
  {
    name: "velocity", view: "velocity",
    js: "document.querySelector('[data-view-panel=velocity] details').open = true",
    fitJs: "(() => { const s = [...document.querySelectorAll('[data-view-panel=velocity] summary')].find((e) => e.textContent.includes('How the comparisons')); return s.closest('details').getBoundingClientRect().top - 16; })()",
  },
  { name: "velocity-movers", view: "velocity", clipJs: "__rect(__p('Top increases'))", pad: 14 },
  { name: "costs", view: "costs", fitJs: panelBottom("Cost by model") },
  { name: "pricing", view: "pricing", fitJs: panelBottom("Model prices") },
  {
    name: "subscription", view: "subscription", waitJs: "document.querySelectorAll('.limit-row').length > 0 && Boolean(document.querySelector('.worth-totals'))",
    fitJs: "Math.max(...[...document.querySelectorAll('.subscription-card')].slice(0, 2).map((card) => card.getBoundingClientRect().bottom))",
  },
  { name: "tools", view: "tools", fitJs: "Math.max(...['#tools-ranking-title', '#tools-profile-title'].map((id) => { const r = __rect(document.querySelector(id).closest('article.panel, section.panel')); return r[1] + r[3]; }))" },
  { name: "activity", view: "activity", fitJs: "document.querySelector('#activity-repositories-panel').getBoundingClientRect().bottom" },
  { name: "coverage", view: "summary", js: "document.querySelector('#coverage-button').click()", clipJs: "__rect(document.querySelector('#coverage-dialog'))", pad: 28 },
  { name: "palette", view: "summary", js: "document.querySelector('#command-button').click()", clipJs: "__rect(document.querySelector('#command-palette'))", pad: 28 },
  { name: "mobile", view: "summary", width: 375, height: 812, density: "compact" },
];

const HELPERS = `window.__p = (title) => {
  const h = [...document.querySelectorAll('[data-view-panel]:not([hidden]) h2, [data-view-panel]:not([hidden]) h3')].find((e) => e.textContent.trim() === title);
  if (!h) throw new Error('no panel ' + title);
  return h.closest('article.panel, section.panel') ?? h.closest('header')?.parentElement ?? h.parentElement;
};
window.__rect = (el) => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }; true`;

const WIDTH = 1280;
const SCALE = 2;
const FIT_PAD = 12;
const COMMAND_TIMEOUT_MS = 30_000;

function losslessWebp(png: string, target: string): void {
  for (const [command, args] of [
    ["cwebp", ["-quiet", "-lossless", "-z", "9", png, "-o", target]],
    ["magick", [png, "-define", "webp:lossless=true", target]],
  ] as const) {
    const result = spawnSync(command, args, { encoding: "utf8" });
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") continue;
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr.trim()}`);
    return;
  }
  throw new Error("Lossless WebP conversion needs cwebp or ImageMagick (magick) on PATH.");
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function chromePath(): string {
  const candidates = [
    option("--chrome"), process.env["CHROME"],
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  ];
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate;
  throw new Error("Google Chrome not found; pass --chrome PATH or set CHROME.");
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

class Session {
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly socket: WebSocket;
  private constructor(socket: WebSocket) {
    this.socket = socket;
    const fail = (reason: string) => () => { for (const [id, waiter] of this.pending) { this.pending.delete(id); waiter.reject(new Error(reason)); } };
    socket.addEventListener("close", fail("DevTools socket closed"));
    socket.addEventListener("error", fail("DevTools socket error"));
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; error?: unknown; result?: unknown };
      const waiter = message.id === undefined ? undefined : this.pending.get(message.id);
      if (!waiter || message.id === undefined) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    });
  }

  static async open(url: string): Promise<Session> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve()); socket.addEventListener("error", () => reject(new Error("DevTools socket failed"))); });
    return new Session(socket);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`${method} timed out after ${COMMAND_TIMEOUT_MS} ms`)); }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = (await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })) as { result: { value: T }; exceptionDetails?: { text: string } };
    if (result.exceptionDetails) throw new Error(`page script failed: ${result.exceptionDetails.text}`);
    return result.result.value;
  }

  metrics(width: number, height: number): Promise<unknown> {
    return this.send("Emulation.setDeviceMetricsOverride", { width, height: Math.round(height), deviceScaleFactor: SCALE, mobile: false });
  }

  close(): void { this.socket.close(); }
}

async function capture(session: Session, base: string, item: Capture, theme: "light" | "dark", outDir: string): Promise<string> {
  const url = `${base}/?density=${item.density ?? "comfortable"}&view=${item.view}&theme=${theme}${item.query ?? ""}`;
  const width = item.width ?? WIDTH;
  let height = item.height ?? 1000;
  await session.metrics(width, height);
  await session.send("Page.navigate", { url });
  let live = false;
  for (let attempt = 0; attempt < 300 && !live; attempt += 1) {
    await sleep(100);
    live = await session.evaluate<boolean>("document.readyState === 'complete' && document.querySelector('#sync-context')?.dataset.state === 'live' && !document.querySelector('.shimmer')");
  }
  if (!live) throw new Error(`${item.name} (${theme}): the dashboard did not reach a live snapshot within 30 seconds.`);
  for (let attempt = 0; item.waitJs && attempt < 300; attempt += 1) {
    if (await session.evaluate<boolean>(item.waitJs)) break;
    if (attempt === 299) throw new Error(`${item.name} (${theme}): the view's data did not arrive within 30 seconds.`);
    await sleep(100);
  }
  await sleep(700);
  await session.evaluate(HELPERS);
  if (item.js) { await session.evaluate(item.js); await sleep(600); }
  const full = await session.evaluate<number>("Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)");
  height = item.height ?? Math.min(Math.max(full, 600), 5000);
  await session.metrics(width, height);
  await sleep(400);
  if (item.fitJs) {
    height = Math.ceil((await session.evaluate<number>(item.fitJs)) + FIT_PAD);
    await session.metrics(width, height);
    await sleep(400);
  }
  const params: Record<string, unknown> = { format: "png", captureBeyondViewport: false };
  if (item.clipJs) {
    const [x, y, w, h] = await session.evaluate<[number, number, number, number]>(item.clipJs);
    const pad = item.pad ?? 0;
    params["clip"] = { x: Math.max(0, x - pad), y: Math.max(0, y - pad), width: w + pad * 2, height: h + pad * 2, scale: 1 };
  }
  const { data } = (await session.send("Page.captureScreenshot", params)) as { data: string };
  const target = join(outDir, `screenshot-${item.name}${theme === "dark" ? "-dark" : ""}.webp`);
  const png = `${target}.png`;
  writeFileSync(png, Buffer.from(data, "base64"));
  try {
    losslessWebp(png, target);
  } finally {
    unlinkSync(png);
  }
  return target;
}

async function main(): Promise<void> {
  const base = (option("--url") ?? "http://127.0.0.1:4175").replace(/\/$/, "");
  const outDir = option("--out") ?? "assets";
  const only = option("--only");
  const items = only ? CAPTURES.filter((item) => item.name === only) : CAPTURES;
  if (items.length === 0) throw new Error(`unknown capture ${only}; known: ${CAPTURES.map((item) => item.name).join(", ")}`);
  const health = await fetch(`${base}/api/health`).catch(() => undefined);
  if (!health?.ok) throw new Error(`no dashboard at ${base}; start the demo first: npm run demo -- --no-open --port 4175`);

  const binary = chromePath();
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), "session-analytics-screenshots-"));
  let chrome: ReturnType<typeof spawn> | undefined;
  let session: Session | undefined;
  try {
    let launchError: Error | undefined;
    chrome = spawn(binary, [
      "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
      "--hide-scrollbars", "--disable-gpu", "--force-color-profile=srgb", `--window-size=${WIDTH},1000`, "about:blank",
    ], { stdio: "ignore" });
    chrome.on("error", (error) => { launchError = error; });
    chrome.on("exit", (code) => { launchError ??= new Error(`Chrome exited early with code ${code}`); });
    let version: { webSocketDebuggerUrl?: string } | undefined;
    for (let attempt = 0; attempt < 100 && !version && !launchError; attempt += 1) {
      await sleep(100);
      version = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.json() as Promise<{ webSocketDebuggerUrl?: string }>).catch(() => undefined);
    }
    if (launchError) throw launchError;
    if (!version?.webSocketDebuggerUrl) throw new Error("Chrome did not expose DevTools.");
    const target = (await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json()) as { id: string; webSocketDebuggerUrl: string };
    session = await Session.open(target.webSocketDebuggerUrl);
    await session.send("Page.enable");
    await session.send("Runtime.enable");
    await session.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    for (const item of items) {
      for (const theme of ["light", "dark"] as const) {
        const written = await capture(session, base, item, theme, outDir);
        console.log(written);
      }
    }
  } finally {
    session?.close();
    chrome?.kill();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
