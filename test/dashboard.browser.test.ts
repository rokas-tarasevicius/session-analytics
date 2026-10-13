// Real-browser interaction checks through the Chrome DevTools protocol (no dependencies). Skipped when Chrome is
// unavailable; set SESSION_ANALYTICS_CHROME to a Chrome/Chromium binary to run it elsewhere.
// SESSION_ANALYTICS_REQUIRE_BROWSER=1 makes missing or unlaunchable Chrome fail the release gate.
//
// Hermetic: the dashboard server reads only the synthetic fixture. It gets its own HOME, data directory and
// explicit source roots, runs offline without the private index or the additional-provider discovery, and inherits
// no SESSION_ANALYTICS_*, CLAUDE_CONFIG_DIR, CODEX_HOME or XDG_* setting from the developer's shell. Every wait
// polls for the state it needs instead of sleeping for a fixed time.
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { createSessionAnalyticsFixture, type SessionAnalyticsFixture } from "./fixtures.ts";
import { stopBrowserProcess as stop } from "./browser-process.ts";

const testRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(testRoot, "..");
const serverPath = join(testRoot, "../src/server.ts");
const chromePath = process.env["SESSION_ANALYTICS_CHROME"] ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const requireBrowser = process.env["SESSION_ANALYTICS_REQUIRE_BROWSER"] === "1";
const browserSkip = existsSync(chromePath) || requireBrowser ? false : "Chrome is not installed";

async function availablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

/** The server's environment: the parent's, minus anything that could point it at real history, plus the fixture. */
function hermeticEnvironment(fixture: SessionAnalyticsFixture, home: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("SESSION_ANALYTICS_") || key.startsWith("XDG_") || key === "CLAUDE_CONFIG_DIR" || key === "CODEX_HOME" || key === "CONDUCTOR_PORT") continue;
    environment[key] = value;
  }
  return {
    ...environment,
    HOME: home,
    TZ: "UTC",
    SESSION_ANALYTICS_DATA_DIR: fixture.dataDir,
    SESSION_ANALYTICS_NO_INDEX: "1",
    SESSION_ANALYTICS_OFFLINE: "1",
    SESSION_ANALYTICS_ADDITIONAL_PROVIDERS: "0",
    SESSION_ANALYTICS_CLAUDE_ROOT: fixture.claudeRoot,
    SESSION_ANALYTICS_CODEX_ARCHIVE_ROOT: fixture.codexArchiveRoot,
    SESSION_ANALYTICS_CODEX_ROOT: fixture.codexRoot,
    SESSION_ANALYTICS_CURSOR_DATABASE: fixture.cursorDatabasePath,
    SESSION_ANALYTICS_CONDUCTOR_DATABASE: fixture.databasePath,
  };
}

async function startServer(environment: NodeJS.ProcessEnv, extra: string[] = []): Promise<{ child: ChildProcess; origin: string }> {
  const port = await availablePort();
  const child = spawn(process.execPath, [serverPath, "--port", String(port), ...extra], { cwd: repositoryRoot, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
  for (let attempt = 0; attempt < 400 && !stdout.includes("ready:"); attempt += 1) await delay(25);
  assert.match(stdout, /ready:/);
  return { child, origin: `http://127.0.0.1:${port}` };
}

interface Browser {
  evaluate<T = unknown>(expression: string): Promise<T>;
  key(key: string, options?: { code?: string; modifiers?: number; text?: string }): Promise<void>;
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, any>>;
  /** Polls `expression` until it is truthy (or equals `expected`) and returns its last value. */
  until<T = unknown>(expression: string, expected?: T, timeout?: number): Promise<T>;
  /** Navigates and waits until the dashboard reports `state` ("live" by default). */
  open(url: string, state?: string): Promise<void>;
  click(selector: string): Promise<void>;
}

async function connect(port: number): Promise<{ browser: Browser; close: () => void }> {
  let targets: Array<{ type: string; webSocketDebuggerUrl: string }> = [];
  for (let attempt = 0; attempt < 100 && !targets.some((target) => target.type === "page"); attempt += 1) {
    try { targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as typeof targets; } catch { await delay(100); }
  }
  const page = targets.find((target) => target.type === "page");
  assert.ok(page, "Chrome exposed no page target");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve(), { once: true }));
  let id = 0;
  const pending = new Map<number, (message: Record<string, any>) => void>();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) { pending.get(message.id)?.(message); pending.delete(message.id); }
  });
  const send = (method: string, params: Record<string, unknown> = {}) => new Promise<Record<string, any>>((resolve) => {
    id += 1; pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params }));
  });
  const keyCodes: Record<string, number> = { ArrowRight: 39, Enter: 13, Escape: 27, Tab: 9, "/": 191, k: 75, t: 84 };
  const evaluate = async <T>(expression: string): Promise<T> => {
    const result = await send("Runtime.evaluate", { awaitPromise: true, expression, returnByValue: true });
    if (result["result"]?.exceptionDetails) throw new Error(`${result["result"].exceptionDetails.exception?.description ?? result["result"].exceptionDetails.text ?? "evaluate failed"}\n${expression}`);
    return result["result"]?.result?.value as T;
  };
  const until = async <T>(expression: string, expected?: T, timeout = 15_000): Promise<T> => {
    const deadline = Date.now() + timeout;
    let value: T | undefined;
    for (;;) {
      try { value = await evaluate<T>(expression); } catch { value = undefined; }
      if (expected === undefined ? Boolean(value) : value === expected) return value as T;
      if (Date.now() > deadline) throw new assert.AssertionError({ message: `Timed out waiting for ${expression}`, actual: value, expected: expected ?? "truthy" });
      await delay(25);
    }
  };
  const browser: Browser = {
    evaluate,
    async key(key, options = {}) {
      const base = { code: options.code ?? key, key, modifiers: options.modifiers ?? 0, windowsVirtualKeyCode: keyCodes[key] ?? key.toUpperCase().charCodeAt(0) };
      await send("Input.dispatchKeyEvent", { ...base, type: options.text ? "keyDown" : "rawKeyDown", ...(options.text ? { text: options.text } : {}) });
      await send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
    },
    send,
    until,
    async open(url, state = "live") {
      // The marker lives on the old document only, so a state read before the new page commits cannot pass.
      await evaluate(`window.__leaving = true`);
      await send("Page.navigate", { url });
      await until(`!window.__leaving && document.readyState === "complete" && document.querySelector('#sync-context')?.dataset.state === ${JSON.stringify(state)}`, true);
    },
    async click(selector) {
      const point = await evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + Math.min(8, r.width / 2), y: r.top + r.height / 2 }; })()`);
      for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 });
    },
  };
  return { browser, close: () => socket.close() };
}

test("laptop tables fit and daily usage chips stay one row tall in both densities", { skip: browserSkip }, async (t) => {
  assert.ok(existsSync(chromePath), `Required browser is missing: ${chromePath}`);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "session-analytics-layout-"));
  let server: ChildProcess | null = null, chrome: ChildProcess | null = null;
  let close = () => {};
  let shutdownChrome: (() => Promise<unknown>) | undefined;
  try {
    const fixture = await createSessionAnalyticsFixture(join(temporaryDirectory, "fixture"));
    const home = join(temporaryDirectory, "home"), demoTemp = join(temporaryDirectory, "demo-temp");
    await mkdir(home); await mkdir(demoTemp);
    // The full demo includes all six providers, History coverage, and enough repositories for the fleet table.
    const demo = spawnSync(process.execPath, [join(repositoryRoot, "scripts/demo.ts"), "report", "--json"], {
      cwd: repositoryRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 60_000,
      env: { ...hermeticEnvironment(fixture, home), TMPDIR: demoTemp, TMP: demoTemp, TEMP: demoTemp },
    });
    assert.equal(demo.status, 0, demo.stderr);
    const snapshot = JSON.parse(demo.stdout);
    assert.equal(new Set(snapshot.sessions.map((session: { provider: string }) => session.provider)).size, 6);
    assert.ok(snapshot.historyCoverage);
    // Long bounded display names must not force the Repository column wider.
    const renamedRepository = snapshot.repositories[0].repository;
    renamedRepository.name = "Synthetic repository with a very long display name";
    for (const session of snapshot.sessions) if (session.repositoryId === renamedRepository.id) session.repositoryName = renamedRepository.name;
    const snapshotPath = join(temporaryDirectory, "snapshot.json");
    await writeFile(snapshotPath, JSON.stringify(snapshot));
    const started = await startServer(hermeticEnvironment(fixture, home), ["--snapshot", snapshotPath]);
    server = started.child;
    const debugPort = await availablePort();
    chrome = spawn(chromePath, ["--headless=new", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${join(temporaryDirectory, "chrome-profile")}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank"], { stdio: "ignore" });
    const connection = await connect(debugPort).catch((error: unknown) => {
      if (chrome && (chrome.exitCode !== null || chrome.signalCode !== null)) return null;
      throw error;
    });
    if (!connection) {
      assert.equal(requireBrowser, false, "Required browser cannot launch in this host sandbox");
      t.skip("Chrome is installed but cannot launch in this host sandbox"); return;
    }
    close = connection.close;
    const { browser } = connection;
    shutdownChrome = () => browser.send("Browser.close");
    await browser.send("Page.enable");
    await browser.open(`${started.origin}/?window=all`);
    await browser.evaluate("document.fonts.ready.then(() => true)");
    for (const density of ["compact", "comfortable"]) for (const [width, height] of [[1280, 800], [1440, 900]]) {
      const label = `${width}×${height} (${density})`;
      await browser.evaluate(`document.documentElement.dataset.density = '${density}'`);
      await browser.send("Emulation.setDeviceMetricsOverride", { deviceScaleFactor: 1, height, mobile: false, width });
      await browser.until(`innerWidth`, width);
      for (const view of ["summary", "velocity", "costs", "pricing", "tools", "activity"]) {
        await browser.evaluate(`document.querySelector('[data-view-button="${view}"]').click()`);
        await browser.until(`document.querySelector('[data-view-panel="${view}"]').hidden`, false);
        const wraps = await browser.evaluate<Array<{ name: string; scroll: number; client: number }>>(`
          [...document.querySelectorAll('.table-wrap')].map((wrap) => ({
            name: wrap.closest('[id]')?.id || wrap.querySelector('table')?.className,
            scroll: wrap.scrollWidth, client: wrap.clientWidth
          }))`);
        for (const wrap of wraps) assert.ok(wrap.scroll <= wrap.client, `${view}: ${wrap.name} at ${label}: ${wrap.scroll} > ${wrap.client}`);
        if (view === "summary") {
          const chips = await browser.evaluate<{ row: number; chip: number; count: number; belowTitle: boolean }>(`(() => {
            const header = document.querySelector('.daily-usage-header'), row = header.querySelector('.provider-key');
            const chips = [...row.querySelectorAll('.chip')].filter((chip) => !chip.hidden);
            return { row: row.getBoundingClientRect().height, chip: chips[0].getBoundingClientRect().height, count: chips.length,
              belowTitle: row.getBoundingClientRect().top >= header.querySelector('h2').getBoundingClientRect().bottom };
          })()`);
          assert.equal(chips.count, 6, label);
          assert.equal(chips.row, chips.chip, `Daily usage chip height at ${label}`);
          assert.equal(chips.belowTitle, true, label);
        }
      }
    }
    // Both shared breakpoints must beat per-view defaults, including the later Pricing stylesheet.
    for (const width of [820, 520, 375]) {
      await browser.send("Emulation.setDeviceMetricsOverride", { deviceScaleFactor: 1, height: 900, mobile: false, width });
      await browser.until(`innerWidth`, width);
      for (const view of ["summary", "velocity", "pricing"]) {
        await browser.evaluate(`document.querySelector('[data-view-button="${view}"]').click()`);
        const columns = await browser.evaluate<number[]>(`[...document.querySelectorAll('[data-view-panel="${view}"] .kpi-grid')].map((grid) => getComputedStyle(grid).gridTemplateColumns.split(' ').length)`);
        assert.ok(columns.length > 0 && columns.every((count) => count === (width < 400 ? 1 : 2)), `${view} has responsive KPI columns at ${width}px`);
      }
    }
  } finally {
    try { await stop(chrome, shutdownChrome); }
    finally { close(); await stop(server); }
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("dashboard interactions in a real browser", { skip: browserSkip }, async (t) => {
  assert.ok(existsSync(chromePath), `Required browser is missing: ${chromePath}`);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "session-analytics-browser-"));
  let server: ChildProcess | null = null;
  let failing: ChildProcess | null = null;
  let chrome: ChildProcess | null = null;
  let close = () => {};
  let shutdownChrome: (() => Promise<unknown>) | undefined;
  try {
    const fixture = await createSessionAnalyticsFixture(join(temporaryDirectory, "fixture"));
    // The Conductor fixture has one priced activity date. Add two native days for chart-specific interactions;
    // single-day windows below still verify the compact legend that replaced the old one-point chart.
    for (const [day, chartSession, input] of [
      ["17", "44444444-4444-4444-8444-444444444444", 100],
      ["18", "55555555-5555-4555-8555-555555555555", 101],
    ] as const) {
      const date = `2026-07-${day}`;
      const usage = { input_tokens: input, cached_input_tokens: 0, output_tokens: 10 };
      await writeFile(join(fixture.codexArchiveRoot, `rollout-${date}T10-00-00-${chartSession}.jsonl`), [
        { type: "session_meta", timestamp: `${date}T10:00:00Z`, payload: { id: chartSession, cwd: "/fixtures/workspaces/conductor/codex-workspace", source: "cli" } },
        { type: "turn_context", timestamp: `${date}T10:00:01Z`, payload: { model: "gpt-5.6-sol" } },
        { type: "event_msg", timestamp: `${date}T10:00:02Z`, payload: { type: "token_count", info: { last_token_usage: usage, total_token_usage: usage } } },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n");
    }
    const home = join(temporaryDirectory, "home");
    await mkdir(home, { recursive: true });
    const environment = hermeticEnvironment(fixture, home);
    const started = await startServer(environment);
    server = started.child;
    const { origin } = started;
    const snapshot = (await (await fetch(`${origin}/api/analytics`)).json()) as { sessions: Array<{ spendByDay: Record<string, number>; createdAt: string; provider: string }>; repositories: Array<{ repository: { id: string; name: string } }> };
    // Only the synthetic fixture is visible: no session from the developer's machine reaches the dashboard.
    assert.ok(snapshot.sessions.length > 0);
    assert.deepEqual([...new Set(snapshot.sessions.map(({ provider }) => provider))].sort(), ["claude", "codex", "cursor"]);

    const debugPort = await availablePort();
    const profile = join(temporaryDirectory, "chrome-profile");
    chrome = spawn(chromePath, ["--headless=new", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=1440,1100", "about:blank"], { stdio: "ignore" });
    const connection = await connect(debugPort).catch((error: unknown) => {
      if (chrome && (chrome.exitCode !== null || chrome.signalCode !== null)) return null;
      throw error;
    });
    if (!connection) {
      assert.equal(requireBrowser, false, "Required browser cannot launch in this host sandbox");
      t.skip("Chrome is installed but cannot launch in this host sandbox");
      return;
    }
    close = connection.close;
    const { browser } = connection;
    shutdownChrome = () => browser.send("Browser.close");
    await browser.send("Page.enable");
    await browser.send("Emulation.setTimezoneOverride", { timezoneId: "UTC" });
    await browser.send("Emulation.setDeviceMetricsOverride", { deviceScaleFactor: 1, height: 1100, mobile: false, width: 1440 });
    // Records the theme the page has when <body> first exists: theme-boot.js must have set it before any paint.
    await browser.send("Page.addScriptToEvaluateOnNewDocument", { source: "new MutationObserver((records, observer) => { if (document.body) { window.__themeAtBody = document.documentElement.dataset.theme ?? null; observer.disconnect(); } }).observe(document, { childList: true, subtree: true });" });

    // A one-visit ?theme= applies before the first paint, is not saved, and leaves the URL once applied.
    await browser.open(`${origin}/?theme=dark`);
    assert.equal(await browser.evaluate(`window.__themeAtBody`), "dark");
    assert.equal(await browser.evaluate(`document.documentElement.dataset.theme`), "dark");
    assert.equal(await browser.evaluate(`localStorage.getItem('session-analytics-theme')`), null);
    assert.equal(await browser.evaluate(`location.search`), "?view=summary");
    assert.equal(await browser.evaluate(`document.querySelector('[data-window-preset="30"]').getAttribute('aria-pressed')`), "true");
    // Provider chips list only the providers in the snapshot.
    assert.deepEqual(await browser.evaluate(`[...document.querySelectorAll('[data-provider-filter]')].filter((input) => !input.closest('.chip').hidden).map((input) => input.dataset.providerFilter)`), ["codex", "claude", "cursor"]);
    // The fixture spans more than 30 days; the interactions below exercise the whole observed history.
    await browser.evaluate(`document.querySelector('[data-window-preset="all"]').click()`);
    await browser.until(`location.search`, "?view=summary&window=all");

    // Native Tab order: skip link, wordmark, palette trigger, then every sidebar view button in sidebar order.
    const navOrder = await browser.evaluate<string[]>(`[...document.querySelectorAll('.view-nav [data-view-button]')].map((button) => button.dataset.viewButton)`);
    assert.deepEqual(navOrder, ["summary", "velocity", "costs", "pricing", "tools", "activity"]);
    const tabbed: string[] = [];
    await browser.evaluate(`document.activeElement?.blur(); window.scrollTo(0, 0)`);
    for (let index = 0; index < 3 + navOrder.length; index += 1) {
      await browser.key("Tab");
      tabbed.push(await browser.evaluate<string>(`(() => { const a = document.activeElement; return a.dataset.viewButton || a.id || a.className || a.tagName; })()`));
    }
    assert.deepEqual(tabbed.slice(0, 3), ["skip-link", "wordmark", "command-button"]);
    assert.deepEqual(tabbed.slice(3), navOrder);
    // Legends are not tab stops; the fleet table offers a real button per repository.
    assert.equal(await browser.evaluate(`document.querySelectorAll('button.chart-legend-item, .chart-legend-item[tabindex]').length`), 0);
    assert.equal(await browser.evaluate(`document.querySelectorAll('#repository-rows tr[role], #repository-rows tr[tabindex]').length`), 0);
    assert.ok((await browser.evaluate<number>(`document.querySelectorAll('#repository-rows button.row-link').length`)) > 0);

    // Palette: opens from its trigger with Enter, traps focus in the input, closes on Escape, restores focus to the trigger.
    await browser.evaluate(`document.querySelector('#command-button').focus()`);
    await browser.key("Enter", { text: "\r" });
    await browser.until(`document.querySelector('#command-palette').open`, true);
    assert.equal(await browser.evaluate(`document.activeElement.id`), "command-input");
    assert.equal(await browser.evaluate(`document.querySelector('#command-input').getAttribute('aria-activedescendant')`), "command-option-0");
    // Ranking: the closest match comes first and weak fuzzy matches drop out.
    await browser.send("Input.insertText", { text: "help" });
    assert.deepEqual(await browser.evaluate(`[...document.querySelectorAll('#command-list .option-label')].map((label) => label.textContent)`), ["Keyboard shortcuts"]);
    await browser.key("Escape");
    await browser.until(`document.querySelector('#command-palette').open`, false);
    assert.equal(await browser.evaluate(`document.activeElement.id`), "command-button");
    // Meta/Ctrl+K toggles it from anywhere; "export" runs the Export entry, which opens the menu on its first download.
    await browser.key("k", { code: "KeyK", modifiers: 4 });
    await browser.until(`document.querySelector('#command-palette').open`, true);
    await browser.send("Input.insertText", { text: "export" });
    assert.equal(await browser.evaluate(`document.querySelector('#command-list .option-label').textContent`), "Export view…");
    await browser.key("Enter", { text: "\r" });
    await browser.until(`document.querySelector('#export-menu').open`, true);
    await browser.until(`document.activeElement?.dataset.export`, "json");
    await browser.key("Escape");
    await browser.until(`document.querySelector('#export-menu').open`, false);

    // Sidebar drill-down keeps keyboard focus on the activated row, marks it pressed and records it in the URL.
    const repositoryId = snapshot.repositories.find(({ repository }) => repository.name === "conductor")?.repository.id;
    assert.ok(repositoryId, "the native chart fixture belongs to the Conductor repository");
    await browser.evaluate(`document.querySelector('#repository-list [data-repository="${repositoryId}"]').focus()`);
    await browser.key("Enter", { text: "\r" });
    await browser.until(`document.querySelector('#repository-filter').value`, repositoryId);
    assert.equal(await browser.evaluate(`document.activeElement.dataset.repository`), repositoryId);
    assert.equal(await browser.evaluate(`document.activeElement.getAttribute('aria-pressed')`), "true");
    assert.equal(await browser.evaluate(`document.querySelector('#scope-chip').hidden`), false);
    assert.match(await browser.evaluate<string>(`document.querySelector('#scope-chip').getAttribute('aria-label')`), /: clear repository focus$/);
    assert.equal(await browser.evaluate(`new URLSearchParams(location.search).get('repo')`), repositoryId);

    // Escape in the export menu closes only the menu; the repository focus survives. An outside press closes it too.
    await browser.evaluate(`document.querySelector('#export-menu summary').click()`);
    await browser.until(`document.querySelector('#export-menu').open`, true);
    await browser.key("Escape");
    await browser.until(`document.querySelector('#export-menu').open`, false);
    assert.equal(await browser.evaluate(`document.querySelector('#repository-filter').value`), repositoryId);
    await browser.evaluate(`document.querySelector('#export-menu summary').click()`);
    await browser.until(`document.querySelector('#export-menu').open`, true);
    await browser.click("#page-title");
    await browser.until(`document.querySelector('#export-menu').open`, false);

    // Escape inside a chart closes the readout without clearing the repository scope; a second Escape clears it.
    await browser.evaluate(`document.querySelector('#daily-spend svg').focus()`);
    await browser.key("ArrowRight");
    await browser.until(`document.querySelector('#daily-spend .chart-tooltip').hidden`, false);
    await browser.key("Escape");
    await browser.until(`document.querySelector('#daily-spend .chart-tooltip').hidden`, true);
    assert.equal(await browser.evaluate(`document.querySelector('#repository-filter').value`), repositoryId);
    await browser.key("Escape");
    await browser.until(`document.querySelector('#repository-filter').value`, "all");
    // Back and Forward restore the repository focus from the URL.
    await browser.evaluate(`history.back()`);
    await browser.until(`document.querySelector('#repository-filter').value`, repositoryId);
    await browser.evaluate(`history.forward()`);
    await browser.until(`document.querySelector('#repository-filter').value`, "all");

    // Daily chart provider toggles are chart-only: the headline total does not move.
    const headline = await browser.evaluate<string>(`document.querySelector('#metric-spend').textContent`);
    await browser.evaluate(`document.querySelector('[data-provider-filter="claude"]').click()`);
    assert.equal(await browser.evaluate(`document.querySelector('#metric-spend').textContent`), headline);
    await browser.evaluate(`document.querySelector('[data-provider-filter="claude"]').click()`);
    // p then a digit toggles the nth chip; a focused checkbox does not swallow single-key shortcuts.
    await browser.evaluate(`document.activeElement?.blur()`);
    await browser.key("p", { code: "KeyP", text: "p" });
    await browser.key("2", { code: "Digit2", text: "2" });
    await browser.until(`document.querySelector('[data-provider-filter="claude"]').checked`, false);
    await browser.key("p", { code: "KeyP", text: "p" });
    await browser.key("2", { code: "Digit2", text: "2" });
    await browser.until(`document.querySelector('[data-provider-filter="claude"]').checked`, true);
    await browser.evaluate(`document.querySelector('[data-provider-filter="codex"]').focus()`);
    await browser.key("t", { code: "KeyT", text: "t" });
    await browser.until(`document.documentElement.dataset.theme`, "light");
    await browser.key("t", { code: "KeyT", text: "t" });
    await browser.until(`document.documentElement.dataset.theme`, "dark");

    // A view switch starts the new view at its top.
    await browser.evaluate(`window.scrollTo(0, document.documentElement.scrollHeight)`);
    assert.ok((await browser.evaluate<number>(`window.scrollY`)) > 0);
    await browser.evaluate(`document.querySelector('[data-view-button="costs"]').click()`);
    await browser.until(`window.scrollY`, 0);
    assert.equal(await browser.evaluate(`location.search`), "?view=costs&window=all");
    await browser.evaluate(`history.back()`);
    await browser.until(`document.querySelector('[data-view-button][aria-current="page"]').dataset.viewButton`, "summary");

    // Retired G M does nothing; model detail now lives in Costs with equal-width rails across each panel.
    await browser.evaluate(`document.activeElement?.blur()`);
    await browser.key("g", { code: "KeyG", text: "g" });
    await browser.key("m", { code: "KeyM", text: "m" });
    assert.equal(await browser.evaluate(`document.querySelector('[data-view-button][aria-current="page"]').dataset.viewButton`), "summary");
    await browser.evaluate(`document.querySelector('[data-view-button="costs"]').click()`);
    await browser.until(`document.querySelector('[data-view-panel="costs"]').hidden`, false);
    assert.equal(await browser.evaluate(`document.querySelector('#repository-cost-components')`), null);
    for (const theme of ["light", "dark"]) for (const width of [1440, 390]) {
      await browser.evaluate(`document.documentElement.dataset.theme = '${theme}'`);
      await browser.send("Emulation.setDeviceMetricsOverride", { deviceScaleFactor: 1, height: 1100, mobile: false, width });
      await browser.until(`innerWidth`, width);
      for (const selector of [".cost-rail", ".cost-model-track"]) {
        const widths = await browser.evaluate<number[]>(`[...document.querySelectorAll('${selector}')].map((rail) => rail.getBoundingClientRect().width)`);
        assert.ok(widths.length > 0 && widths.every((value) => value > 0 && Math.abs(value - widths[0]!) < 1));
      }
      assert.equal(await browser.evaluate(`document.documentElement.scrollWidth <= innerWidth`), true);
    }
    await browser.send("Emulation.setDeviceMetricsOverride", { deviceScaleFactor: 1, height: 1100, mobile: false, width: 1440 });
    await browser.until(`innerWidth`, 1440);
    await browser.evaluate(`document.documentElement.dataset.theme = 'dark'; document.querySelector('[data-view-button="velocity"]').click()`);
    await browser.until(`document.querySelector('#velocity-view')?.firstElementChild?.classList.contains('velocity-lead')`, true);
    assert.equal(await browser.evaluate(`document.querySelector('.velocity-lead article:last-child strong').textContent`), headline);
    // Velocity chips list the snapshot's providers, and p 1 toggles the first of them.
    assert.deepEqual(await browser.evaluate(`[...document.querySelectorAll('#velocity-view .provider-key .chip')].map((chip) => chip.dataset.provider)`), ["codex", "claude", "cursor"]);
    await browser.evaluate(`document.activeElement?.blur()`);
    await browser.key("p", { code: "KeyP", text: "p" });
    await browser.key("1", { code: "Digit1", text: "1" });
    await browser.until(`document.querySelector('#velocity-view [data-provider="codex"] input').checked`, false);
    assert.match(await browser.evaluate<string>(`document.querySelector('#velocity-view').textContent`), /2 of 3 providers/);
    await browser.evaluate(`document.querySelector('#velocity-view [data-provider="codex"] input').click()`);
    await browser.evaluate(`document.querySelector('[data-view-button="summary"]').click()`);
    await browser.until(`document.querySelector('[data-view-panel="summary"]').hidden`, false);

    // A single-day custom window uses the compact provider-value legend; its dates are in the URL.
    const spendDay = Object.keys(snapshot.sessions.find((item) => Object.keys(item.spendByDay).length)?.spendByDay ?? {})[0];
    assert.ok(spendDay, "fixture has a day with priced usage");
    const setDates = (start: string, end: string) => browser.evaluate(`(() => { const s = document.querySelector('#window-start'), e = document.querySelector('#window-end'); s.value = '${start}'; e.value = '${end}'; e.dispatchEvent(new Event('change')); })()`);
    await browser.evaluate(`document.querySelector('[data-window-preset="custom"]').click()`);
    await setDates(spendDay, spendDay);
    await browser.until(`document.querySelectorAll('#daily-spend .chart-legend-value').length >= 1`, true);
    assert.equal(await browser.evaluate(`document.querySelector('#daily-spend svg')`), null);
    assert.match(await browser.evaluate<string>(`document.querySelector('#daily-spend').textContent`), /Only .* has activity/);
    assert.equal(await browser.evaluate(`location.search`), `?view=summary&window=custom&start=${spendDay}&end=${spendDay}`);
    // Clearing the end date keeps the start, and leaving the field restores the end.
    await browser.evaluate(`(() => { const e = document.querySelector('#window-end'); e.focus(); e.value = ''; e.dispatchEvent(new Event('change')); e.blur(); })()`);
    assert.deepEqual(await browser.evaluate(`[document.querySelector('#window-start').value, document.querySelector('#window-end').value]`), [spendDay, spendDay]);
    const activityDays = [...new Set(snapshot.sessions.flatMap((session) => Object.keys(session.spendByDay)))].sort();
    assert.ok(activityDays.length >= 3, "chart fixture has at least three priced activity dates");
    await setDates(activityDays[0]!, activityDays[1]!);
    assert.equal(await browser.evaluate(`document.querySelector('#daily-spend svg')`), null);
    assert.match(await browser.evaluate<string>(`document.querySelector('#daily-spend').textContent`), /Only .* and .* have activity/);
    // A reversed range swaps, a range beyond the history is clamped, and the note says so.
    const minimum = await browser.evaluate<string>(`document.querySelector('#window-start').min`);
    const maximum = await browser.evaluate<string>(`document.querySelector('#window-end').max`);
    await setDates(maximum, minimum);
    assert.deepEqual(await browser.evaluate(`[document.querySelector('#window-start').value, document.querySelector('#window-end').value]`), [minimum, maximum]);
    assert.match(await browser.evaluate<string>(`document.querySelector('#window-note').textContent`), /swapped/);
    await setDates("2000-01-01", "2999-12-31");
    assert.deepEqual(await browser.evaluate(`[document.querySelector('#window-start').value, document.querySelector('#window-end').value]`), [minimum, maximum]);
    assert.match(await browser.evaluate<string>(`document.querySelector('#window-note').textContent`), /Clamped to history/);
    assert.equal(await browser.evaluate(`document.querySelector('#window-note').hidden`), false);
    await browser.evaluate(`document.querySelector('[data-window-preset="all"]').click()`);
    await browser.until(`document.querySelector('#window-note').hidden`, true);

    // Per-view provider filters are independent and the heatmap tooltip never survives a view switch.
    await browser.evaluate(`document.querySelector('[data-view-button="activity"]').click()`);
    await browser.until(`document.querySelector('#activity-provider-filters [data-focus-key="filter:activity:claude"]')`);
    await browser.evaluate(`document.querySelector('#activity-provider-filters [data-focus-key="filter:activity:claude"]').click()`);
    await browser.until(`document.querySelector('#activity-provider-filters [data-focus-key="filter:activity:claude"]').checked`, false);
    await browser.evaluate(`document.querySelector('.heat-cell').focus()`);
    assert.equal(await browser.evaluate(`document.querySelector('#activity-tooltip').hidden`), false);
    await browser.evaluate(`document.querySelector('[data-view-button="tools"]').click()`);
    await browser.until(`document.querySelector('#tools-provider-filters [data-focus-key="filter:tools:claude"]')`);
    assert.equal(await browser.evaluate(`document.querySelector('#activity-tooltip').hidden`), true);
    assert.equal(await browser.evaluate(`document.querySelector('#tools-provider-filters [data-focus-key="filter:tools:claude"]').checked`), true);

    // Refresh: the button, r and the palette share one in-flight request.
    await browser.evaluate(`document.querySelector('[data-view-button="summary"]').click()`);
    await browser.evaluate(`(() => { window.__refreshes = 0; const original = window.fetch; window.fetch = (url, ...rest) => { if (String(url).includes('refresh=1')) window.__refreshes += 1; return original(url, ...rest); }; })()`);
    await browser.evaluate(`(() => {
      document.querySelector('#refresh-button').click();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }));
      document.querySelector('#command-button').click();
      const input = document.querySelector('#command-input'); input.value = 'refresh snapshot'; input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    })()`);
    await browser.until(`document.querySelector('#sync-context').dataset.state`, "live");
    assert.equal(await browser.evaluate(`window.__refreshes`), 1);
    // A failed refresh keeps the last snapshot on screen, marks it stale and offers Retry.
    await browser.evaluate(`(() => { const original = window.fetch; window.__restoreFetch = () => { window.fetch = original; }; window.fetch = async (url, ...rest) => String(url).includes('/api/analytics') ? new Response(JSON.stringify({ error: 'Local analytics evidence is unavailable or could not be parsed.' }), { status: 502, headers: { 'content-type': 'application/json' } }) : original(url, ...rest); })()`);
    await browser.evaluate(`document.querySelector('#refresh-button').click()`);
    await browser.until(`document.querySelector('#sync-context').dataset.state`, "error");
    assert.equal(await browser.evaluate(`document.querySelector('#error-banner').hidden`), false);
    assert.equal(await browser.evaluate(`document.querySelector('#error-title').textContent`), "Couldn't refresh");
    assert.match(await browser.evaluate<string>(`document.querySelector('#error-message').textContent`), / You are looking at the snapshot from /);
    assert.match(await browser.evaluate<string>(`document.querySelector('#generated-at').textContent`), /· stale$/);
    assert.equal(await browser.evaluate(`document.querySelector('#metric-spend').textContent`), headline);
    assert.equal(await browser.evaluate(`document.querySelector('#error-retry').hidden`), false);
    // Regression: stale snapshot metadata must wrap instead of widening a narrow phone.
    await browser.send("Emulation.setDeviceMetricsOverride", { deviceScaleFactor: 1, height: 812, mobile: false, width: 375 });
    await browser.until(`innerWidth`, 375);
    assert.equal(await browser.evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true, "Stale snapshot fits a 375px phone");
    await browser.send("Emulation.setDeviceMetricsOverride", { deviceScaleFactor: 1, height: 1100, mobile: false, width: 1440 });
    await browser.until(`innerWidth`, 1440);
    await browser.evaluate(`window.__restoreFetch(); document.querySelector('#error-retry').click()`);
    await browser.until(`document.querySelector('#sync-context').dataset.state`, "live");
    assert.equal(await browser.evaluate(`document.querySelector('#error-banner').hidden`), true);
    assert.doesNotMatch(await browser.evaluate<string>(`document.querySelector('#generated-at').textContent`), /stale/);

    // Single-key shortcuts can be switched off; modifier shortcuts keep working and tooltips stop naming keys.
    await browser.evaluate(`document.activeElement?.blur()`);
    assert.equal(await browser.evaluate(`document.querySelector('#refresh-button').title`), "Refresh snapshot (r)");
    await browser.key("t", { code: "KeyT", text: "t" });
    await browser.until(`document.documentElement.dataset.theme`, "light");
    assert.equal(await browser.evaluate(`localStorage.getItem('session-analytics-theme')`), "light");
    await browser.evaluate(`(() => { const toggle = document.querySelector('#shortcuts-toggle'); toggle.checked = false; toggle.dispatchEvent(new Event('change')); })()`);
    assert.equal(await browser.evaluate(`document.querySelector('#refresh-button').title`), "Refresh snapshot");
    await browser.key("t", { code: "KeyT", text: "t" });
    assert.equal(await browser.evaluate(`document.documentElement.dataset.theme`), "light");
    assert.equal(await browser.evaluate(`localStorage.getItem('session-analytics-shortcuts')`), "off");
    await browser.key("k", { code: "KeyK", modifiers: 4 });
    await browser.until(`document.querySelector('#command-palette').open`, true);
    await browser.key("Escape");
    await browser.evaluate(`localStorage.setItem('session-analytics-shortcuts', 'on')`);

    // URL windows override the default without persisting into the next visit; a custom range comes back too.
    for (const [query, expected] of [["?window=all", "all"], ["?window=7", "7"], ["?window=invalid", "30"], ["", "30"]]) {
      await browser.open(`${origin}/${query}`);
      assert.equal(await browser.evaluate(`document.querySelector('#window-segment [aria-pressed="true"]').dataset.windowPreset`), expected);
    }
    await browser.open(`${origin}/?view=costs&window=custom&start=${spendDay}&end=${spendDay}`);
    assert.equal(await browser.evaluate(`document.querySelector('#window-segment [aria-pressed="true"]').dataset.windowPreset`), "custom");
    assert.deepEqual(await browser.evaluate(`[document.querySelector('#window-start').value, document.querySelector('#window-end').value]`), [spendDay, spendDay]);
    assert.equal(await browser.evaluate(`document.querySelector('[data-view-panel="costs"]').hidden`), false);
    // A one-shot ?open=palette opens the palette once and leaves the URL.
    await browser.open(`${origin}/?open=palette`);
    await browser.until(`document.querySelector('#command-palette').open`, true);
    assert.equal(await browser.evaluate(`new URLSearchParams(location.search).has('open')`), false);
    await browser.key("Escape");

    for (const query of ["?view=models", ""]) {
      await browser.evaluate(`localStorage.setItem('session-analytics-view', 'models')`);
      await browser.open(`${origin}/${query}`);
      assert.equal(await browser.evaluate(`document.querySelector('[data-view-panel="costs"]').hidden`), false);
    }

    // Every view contains its overflow at phone, tablet and desktop widths, in both themes and densities, and its line chart
    // is drawn at the container's pixel width. clientWidth excludes a classic scrollbar, so no overflow hides behind one.
    const setWidth = async (width: number) => {
      await browser.send("Emulation.setDeviceMetricsOverride", { deviceScaleFactor: 1, height: 1100, mobile: false, width });
      await browser.until(`innerWidth`, width);
    };
    const chartAtContainerWidth = `(() => {
      const svg = document.querySelector('[data-view-panel]:not([hidden]) :is(#daily-spend, .velocity-chart) > svg');
      return !svg || Math.abs(svg.viewBox.baseVal.width - Math.max(280, svg.parentElement.clientWidth)) <= 1;
    })()`;
    for (const theme of ["light", "dark"]) for (const density of ["compact", "comfortable"]) {
      await browser.evaluate(`document.documentElement.dataset.theme = '${theme}'; document.documentElement.dataset.density = '${density}'`);
      for (const view of ["summary", "velocity", "costs", "pricing", "tools", "activity"]) for (const width of [375, 768, 1024, 1280, 1440]) {
        await setWidth(width);
        await browser.evaluate(`document.querySelector('[data-view-button="${view}"]').click()`);
        await delay(150);
        assert.equal(await browser.evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true, `${view} at ${width}px (${theme}, ${density})`);
        await browser.until(chartAtContainerWidth, true);
        if (width >= 1280) {
          assert.equal(await browser.evaluate(`(() => {
            const panel = document.querySelector('[data-view-panel]:not([hidden])');
            const maxLines = ${view === "costs" && width === 1280 && density === "comfortable" ? 2 : 1};
            return [...panel.querySelectorAll('.chart-note, .kpi-note')].every((note) =>
              note.getBoundingClientRect().height <= maxLines * parseFloat(getComputedStyle(note).lineHeight) + 1
              && note.scrollHeight <= note.clientHeight + 1);
          })()`), true, `${view} notes stay readable without clipping at ${width}px (${theme}, ${density})`);
          if (view === "summary") {
            assert.equal(await browser.evaluate(`(() => {
              const cards = [...document.querySelectorAll('.summary-metrics > .kpi')];
              return cards.length === 6 && cards.every((card) => cards.every((other) => {
                const a = card.getBoundingClientRect(), b = other.getBoundingClientRect();
                return Math.abs(a.top - b.top) > 1 || Math.abs(a.height - b.height) <= 1;
              }));
            })()`), true, `Six equal-height Summary KPIs at ${width}px (${theme}, ${density})`);
            assert.equal(await browser.evaluate(`document.querySelector('[data-view-panel="summary"] .kicker')`), null);
          }
          if (view === "velocity") assert.equal(await browser.evaluate(`getComputedStyle(document.querySelector('.velocity-inspection')).display`), "grid");
        }
      }
      await setWidth(375);
      assert.equal(await browser.evaluate(`getComputedStyle(document.querySelector('#window-segment')).display`), "none");
      assert.notEqual(await browser.evaluate(`getComputedStyle(document.querySelector('.window-select-wrap')).display`), "none");
      for (const preset of ["7", "90", "all", "custom", "30"]) {
        await browser.evaluate(`(() => { const select = document.querySelector('#window-select'); select.value = '${preset}'; select.dispatchEvent(new Event('change')); })()`);
        assert.equal(await browser.evaluate(`document.querySelector('#window-segment [aria-pressed="true"]').dataset.windowPreset`), preset);
        assert.equal(await browser.evaluate(`document.querySelector('#date-range').hidden`), preset !== "custom");
        if (preset === "custom") assert.equal(await browser.evaluate(`document.activeElement.id`), "window-start");
        assert.equal(await browser.evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true, `Mobile ${preset} window fits (${theme}, ${density})`);
      }
      await setWidth(1024);
      await browser.evaluate(`document.querySelector('[data-window-preset="custom"]').click()`);
      await delay(150);
      assert.equal(await browser.evaluate(`(() => {
        const dates = document.querySelector('#date-range').getBoundingClientRect();
        const status = document.querySelector('#sync-context').getBoundingClientRect();
        return dates.right <= status.left || dates.left >= status.right || dates.bottom <= status.top || dates.top >= status.bottom;
      })()`), true, `Custom window and status do not overlap at 1024px (${theme}, ${density})`);
      await browser.evaluate(`document.querySelector('[data-window-preset="all"]').click()`);
    }
    await browser.evaluate(`document.documentElement.dataset.theme = 'light'; document.documentElement.dataset.density = 'compact'`);

    // Resizing redraws the chart at the new width without a view switch, and keyboard focus stays on the chart.
    await setWidth(1440);
    await browser.evaluate(`document.querySelector('[data-view-button="summary"]').click()`);
    await browser.until(chartAtContainerWidth, true);
    await browser.evaluate(`document.querySelector('#daily-spend svg').focus()`);
    await setWidth(1024);
    await browser.until(`document.querySelector('#daily-spend svg').viewBox.baseVal.width < 900`, true);
    await browser.until(chartAtContainerWidth, true);
    assert.equal(await browser.evaluate(`document.activeElement === document.querySelector('#daily-spend svg')`), true);
    await browser.evaluate(`document.activeElement.blur()`);

    // The coverage dialog opens on its title (no focus ring on Close), keeps its table scrolling inside it on a phone,
    // and Escape returns focus to the button that opened it.
    await setWidth(390);
    await browser.evaluate(`document.querySelector('#coverage-button').focus(); document.querySelector('#coverage-button').click()`);
    await browser.until(`document.querySelector('#coverage-dialog').open`, true);
    assert.equal(await browser.evaluate(`document.activeElement.id`), "coverage-title");
    assert.equal(await browser.evaluate(`(() => { const d = document.querySelector('#coverage-dialog'); return d.scrollWidth <= d.clientWidth && d.getBoundingClientRect().right <= innerWidth; })()`), true);
    assert.equal(await browser.evaluate(`(() => { const w = document.querySelector('#coverage-dialog .table-wrap'); return w.scrollWidth > w.clientWidth; })()`), true);
    await browser.key("Escape");
    await browser.until(`document.querySelector('#coverage-dialog').open`, false);
    assert.equal(await browser.evaluate(`document.activeElement.id`), "coverage-button");

    // On a touch screen the controls grow to finger size, key hints disappear, and the page still fits.
    await browser.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await browser.until(`matchMedia('(pointer: coarse)').matches`, true);
    await setWidth(375);
    assert.equal(await browser.evaluate(`[...document.querySelectorAll('#window-select, #refresh-button, #theme-switch, #density-switch')].every((control) => control.getBoundingClientRect().height >= 40)`), true);
    assert.equal(await browser.evaluate(`getComputedStyle(document.querySelector('.palette-trigger kbd')).display`), "none");
    assert.equal(await browser.evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true);
    await setWidth(768);
    assert.notEqual(await browser.evaluate(`getComputedStyle(document.querySelector('#window-segment')).display`), "none");
    assert.equal(await browser.evaluate(`[...document.querySelectorAll('#window-segment button')].every((control) => control.getBoundingClientRect().height >= 40)`), true, "Tablet time-window buttons retain touch targets");
    assert.equal(await browser.evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true, "Tablet touch controls fit the page");
    await browser.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await setWidth(1440);

    // Icon rail keeps every view name in the accessibility tree and shows a hover label.
    await browser.send("Emulation.setDeviceMetricsOverride", { deviceScaleFactor: 1, height: 1100, mobile: false, width: 900 });
    await browser.until(`innerWidth`, 900);
    assert.equal(await browser.evaluate(`getComputedStyle(document.querySelector('[data-view-button="costs"] span')).position`), "absolute");
    assert.equal(await browser.evaluate(`document.querySelector('[data-view-button="costs"]').textContent.trim()`), "Costsg c");
    assert.equal(await browser.evaluate(`getComputedStyle(document.querySelector('[data-view-button="costs"]'), '::after').content`), '"Costs"');
    assert.equal(await browser.evaluate(`getComputedStyle(document.querySelector('.repository-select-wrap')).display`), "block");
    await browser.send("Emulation.setDeviceMetricsOverride", { deviceScaleFactor: 1, height: 1100, mobile: false, width: 1440 });

    // A failed first load shows a "No snapshot" state with Retry, and the export menu says why nothing exports.
    const badSnapshot = join(temporaryDirectory, "bad-snapshot.json");
    await writeFile(badSnapshot, `${JSON.stringify({ schemaVersion: 99 })}\n`);
    const broken = await startServer(environment, ["--snapshot", badSnapshot]);
    failing = broken.child;
    await browser.open(`${broken.origin}/`, "error");
    assert.equal(await browser.evaluate(`document.querySelector('#error-banner').hidden`), false);
    assert.equal(await browser.evaluate(`document.querySelector('#error-retry').hidden`), false);
    assert.match(await browser.evaluate<string>(`document.querySelector('#view-status').textContent`), /No snapshot/);
    assert.equal(await browser.evaluate(`[...document.querySelectorAll('[data-view-panel]')].every((panel) => panel.hidden)`), true);
    await browser.evaluate(`document.querySelector('#export-menu summary').click()`);
    await browser.until(`document.querySelector('#export-description').textContent`, "Nothing to export: the analysis failed. Use Retry in the banner.");
    await browser.key("Escape");
    await browser.evaluate(`document.querySelector('#error-retry').click()`);
    await browser.until(`document.querySelector('#sync-context').dataset.state`, "error");
    assert.match(await browser.evaluate<string>(`document.querySelector('#view-status').textContent`), /No snapshot/);
  } finally {
    try { await stop(chrome, shutdownChrome); }
    finally { close(); await Promise.all([stop(failing), stop(server)]); }
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});
