// Real-browser interaction checks through the Chrome DevTools protocol (no dependencies). Skipped when Chrome is
// unavailable; set SESSION_ANALYTICS_CHROME to a Chrome/Chromium binary to run it elsewhere.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { createSessionAnalyticsFixture } from "./fixtures.ts";

const testRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(testRoot, "..");
const serverPath = join(testRoot, "../src/server.ts");
const chromePath = process.env["SESSION_ANALYTICS_CHROME"] ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function availablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function stop(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([exited, delay(3_000, undefined, { ref: false })]);
}

interface Browser {
  evaluate<T = unknown>(expression: string): Promise<T>;
  key(key: string, options?: { code?: string; modifiers?: number; text?: string }): Promise<void>;
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, any>>;
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
  const keyCodes: Record<string, number> = { ArrowRight: 39, Enter: 13, Escape: 27, Tab: 9, k: 75, t: 84 };
  const browser: Browser = {
    async evaluate(expression) {
      const result = await send("Runtime.evaluate", { awaitPromise: true, expression, returnByValue: true });
      if (result["result"]?.exceptionDetails) throw new Error(result["result"].exceptionDetails.text ?? "evaluate failed");
      return result["result"]?.result?.value;
    },
    async key(key, options = {}) {
      const base = { code: options.code ?? key, key, modifiers: options.modifiers ?? 0, windowsVirtualKeyCode: keyCodes[key] ?? key.toUpperCase().charCodeAt(0) };
      await send("Input.dispatchKeyEvent", { ...base, type: options.text ? "keyDown" : "rawKeyDown", ...(options.text ? { text: options.text } : {}) });
      await send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
    },
    send,
  };
  return { browser, close: () => socket.close() };
}

test("dashboard interactions in a real browser", { skip: existsSync(chromePath) ? false : "Chrome is not installed" }, async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "session-analytics-browser-"));
  let server: ChildProcess | null = null;
  let chrome: ChildProcess | null = null;
  let close = () => {};
  try {
    const fixture = await createSessionAnalyticsFixture(temporaryDirectory);
    const serverPort = await availablePort();
    server = spawn(process.execPath, [serverPath, "--port", String(serverPort)], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        SESSION_ANALYTICS_CLAUDE_ROOT: fixture.claudeRoot,
        SESSION_ANALYTICS_CODEX_ARCHIVE_ROOT: fixture.codexArchiveRoot,
        SESSION_ANALYTICS_CODEX_ROOT: fixture.codexRoot,
        SESSION_ANALYTICS_CURSOR_DATABASE: fixture.cursorDatabasePath,
        SESSION_ANALYTICS_CONDUCTOR_DATABASE: fixture.databasePath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    server.stdout?.setEncoding("utf8");
    server.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    for (let attempt = 0; attempt < 200 && !stdout.includes("ready:"); attempt += 1) await delay(50);
    assert.match(stdout, /ready:/);
    const origin = `http://127.0.0.1:${serverPort}`;
    const snapshot = (await (await fetch(`${origin}/api/analytics`)).json()) as { sessions: Array<{ spendByDay: Record<string, number>; createdAt: string }> };

    const debugPort = await availablePort();
    const profile = join(temporaryDirectory, "chrome-profile");
    chrome = spawn(chromePath, ["--headless=new", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=1440,1100", "about:blank"], { stdio: "ignore" });
    const connection = await connect(debugPort).catch((error: unknown) => {
      if (chrome && (chrome.exitCode !== null || chrome.signalCode !== null)) return null;
      throw error;
    });
    if (!connection) {
      t.skip("Chrome is installed but cannot launch in this host sandbox");
      return;
    }
    close = connection.close;
    const { browser } = connection;
    await browser.send("Page.enable");
    await browser.send("Emulation.setDeviceMetricsOverride", { deviceScaleFactor: 1, height: 1100, mobile: false, width: 1440 });
    await browser.send("Page.navigate", { url: `${origin}/?theme=dark` });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if ((await browser.evaluate<string>(`document.querySelector('#sync-context')?.dataset.state ?? 'loading'`)) === "live") break;
      await delay(100);
    }
    assert.equal(await browser.evaluate(`document.querySelector('#sync-context').dataset.state`), "live");
    assert.equal(await browser.evaluate(`document.querySelector('[data-window-preset="30"]').getAttribute('aria-pressed')`), "true");
    assert.equal(await browser.evaluate(`document.querySelector('[data-window-preset="all"]').getAttribute('aria-pressed')`), "false");
    // The fixture spans more than 30 days; the interactions below exercise the whole observed history.
    await browser.evaluate(`document.querySelector('[data-window-preset="all"]').click()`);
    await delay(150);

    // Native Tab order: skip link, wordmark, palette trigger, then every sidebar view button in sidebar order.
    const navOrder = await browser.evaluate<string[]>(`[...document.querySelectorAll('.view-nav [data-view-button]')].map((button) => button.dataset.viewButton)`);
    assert.deepEqual(navOrder, ["summary", "velocity", "costs", "pricing", "tools", "activity"]);
    const tabbed: string[] = [];
    for (let index = 0; index < 3 + navOrder.length; index += 1) {
      await browser.key("Tab");
      tabbed.push(await browser.evaluate<string>(`(() => { const a = document.activeElement; return a.dataset.viewButton || a.id || a.className || a.tagName; })()`));
    }
    assert.deepEqual(tabbed.slice(0, 3), ["skip-link", "wordmark", "command-button"]);
    assert.deepEqual(tabbed.slice(3), navOrder);

    // Palette: opens from its trigger with Enter, traps focus in the input, closes on Escape, restores focus to the trigger.
    await browser.evaluate(`document.querySelector('#command-button').focus()`);
    await browser.key("Enter", { text: "\r" });
    await delay(150);
    assert.equal(await browser.evaluate(`document.querySelector('#command-palette').open`), true);
    assert.equal(await browser.evaluate(`document.activeElement.id`), "command-input");
    assert.equal(await browser.evaluate(`document.querySelector('#command-input').getAttribute('aria-activedescendant')`), "command-option-0");
    await browser.key("Escape");
    await delay(150);
    assert.equal(await browser.evaluate(`document.querySelector('#command-palette').open`), false);
    assert.equal(await browser.evaluate(`document.activeElement.id`), "command-button");
    // Meta/Ctrl+K toggles it from anywhere.
    await browser.key("k", { code: "KeyK", modifiers: 4 });
    await delay(150);
    assert.equal(await browser.evaluate(`document.querySelector('#command-palette').open`), true);
    await browser.key("Escape");
    await delay(100);

    // Sidebar drill-down keeps keyboard focus on the activated row and marks it pressed.
    const repositoryId = await browser.evaluate<string>(`document.querySelector('#repository-list [data-repository]:not([data-repository="all"])').dataset.repository`);
    await browser.evaluate(`document.querySelector('#repository-list [data-repository="${repositoryId}"]').focus()`);
    await browser.key("Enter", { text: "\r" });
    await delay(200);
    assert.equal(await browser.evaluate(`document.querySelector('#repository-filter').value`), repositoryId);
    assert.equal(await browser.evaluate(`document.activeElement.dataset.repository`), repositoryId);
    assert.equal(await browser.evaluate(`document.activeElement.getAttribute('aria-pressed')`), "true");
    assert.equal(await browser.evaluate(`document.querySelector('#scope-chip').hidden`), false);

    // Escape inside a chart closes the readout without clearing the repository scope; a second Escape clears it.
    await browser.evaluate(`document.querySelector('#daily-spend svg').focus()`);
    await browser.key("ArrowRight");
    assert.equal(await browser.evaluate(`document.querySelector('#daily-spend .chart-tooltip').hidden`), false);
    await browser.key("Escape");
    await delay(100);
    assert.equal(await browser.evaluate(`document.querySelector('#daily-spend .chart-tooltip').hidden`), true);
    assert.equal(await browser.evaluate(`document.querySelector('#repository-filter').value`), repositoryId);
    await browser.key("Escape");
    await delay(200);
    assert.equal(await browser.evaluate(`document.querySelector('#repository-filter').value`), "all");

    // Daily chart provider toggles are chart-only: the headline total does not move.
    const headline = await browser.evaluate<string>(`document.querySelector('#metric-spend').textContent`);
    await browser.evaluate(`document.querySelector('[data-provider-filter="claude"]').click()`);
    await delay(150);
    assert.equal(await browser.evaluate(`document.querySelector('#metric-spend').textContent`), headline);
    await browser.evaluate(`document.querySelector('[data-provider-filter="claude"]').click()`);

    // Retired G M does nothing; model detail now lives in Costs with equal-width rails across each panel.
    await browser.evaluate(`document.body.focus()`);
    await browser.key("g", { code: "KeyG", text: "g" });
    await browser.key("m", { code: "KeyM", text: "m" });
    assert.equal(await browser.evaluate(`document.querySelector('[data-view-button][aria-current="page"]').dataset.viewButton`), "summary");
    await browser.evaluate(`document.querySelector('[data-view-button="costs"]').click()`);
    assert.equal(await browser.evaluate(`document.querySelector('#repository-cost-components')`), null);
    for (const theme of ["light", "dark"]) for (const width of [1440, 390]) {
      await browser.evaluate(`document.documentElement.dataset.theme = '${theme}'`);
      await browser.send("Emulation.setDeviceMetricsOverride", { deviceScaleFactor: 1, height: 1100, mobile: false, width });
      await delay(100);
      for (const selector of [".cost-rail", ".cost-model-track"]) {
        const widths = await browser.evaluate<number[]>(`[...document.querySelectorAll('${selector}')].map((rail) => rail.getBoundingClientRect().width)`);
        assert.ok(widths.length > 0 && widths.every((value) => value > 0 && Math.abs(value - widths[0]!) < 1));
      }
      assert.equal(await browser.evaluate(`document.documentElement.scrollWidth <= innerWidth`), true);
    }
    await browser.send("Emulation.setDeviceMetricsOverride", { deviceScaleFactor: 1, height: 1100, mobile: false, width: 1440 });
    await browser.evaluate(`document.documentElement.dataset.theme = 'dark'; document.querySelector('[data-view-button="velocity"]').click()`);
    assert.equal(await browser.evaluate(`document.querySelector('#velocity-view').firstElementChild.classList.contains('velocity-lead')`), true);
    assert.equal(await browser.evaluate(`document.querySelector('.velocity-lead article:last-child strong').textContent`), headline);
    await browser.evaluate(`document.querySelector('[data-view-button="summary"]').click()`);

    // A single-day custom window draws persistent data points.
    const spendDay = Object.keys(snapshot.sessions.find((item) => Object.keys(item.spendByDay).length)?.spendByDay ?? {})[0];
    assert.ok(spendDay, "fixture has a day with priced usage");
    await browser.evaluate(`(() => { document.querySelector('[data-window-preset="custom"]').click(); const s = document.querySelector('#window-start'), e = document.querySelector('#window-end'); s.value = '${spendDay}'; e.value = '${spendDay}'; e.dispatchEvent(new Event('change')); })()`);
    await delay(200);
    assert.ok((await browser.evaluate<number>(`document.querySelectorAll('#daily-spend .trend-point').length`)) >= 1);
    await browser.evaluate(`document.querySelector('[data-window-preset="all"]').click()`);

    // Per-view provider filters are independent and the heatmap tooltip never survives a view switch.
    await browser.evaluate(`document.querySelector('[data-view-button="activity"]').click()`);
    await delay(200);
    await browser.evaluate(`document.querySelector('#activity-provider-filters [data-focus-key="filter:activity:claude"]').click()`);
    await delay(150);
    assert.equal(await browser.evaluate(`document.querySelector('#activity-provider-filters [data-focus-key="filter:activity:claude"]').checked`), false);
    await browser.evaluate(`document.querySelector('.heat-cell').focus()`);
    assert.equal(await browser.evaluate(`document.querySelector('#activity-tooltip').hidden`), false);
    await browser.evaluate(`document.querySelector('[data-view-button="tools"]').click()`);
    await delay(200);
    assert.equal(await browser.evaluate(`document.querySelector('#activity-tooltip').hidden`), true);
    assert.equal(await browser.evaluate(`document.querySelector('#tools-provider-filters [data-focus-key="filter:tools:claude"]').checked`), true);

    // Single-key shortcuts can be switched off; modifier shortcuts keep working.
    await browser.evaluate(`document.querySelector('[data-view-button="summary"]').click()`);
    await browser.evaluate(`document.body.focus()`);
    await browser.key("t", { code: "KeyT", text: "t" });
    assert.equal(await browser.evaluate(`document.documentElement.dataset.theme`), "light");
    await browser.evaluate(`(() => { const toggle = document.querySelector('#shortcuts-toggle'); toggle.checked = false; toggle.dispatchEvent(new Event('change')); })()`);
    await browser.key("t", { code: "KeyT", text: "t" });
    assert.equal(await browser.evaluate(`document.documentElement.dataset.theme`), "light");
    assert.equal(await browser.evaluate(`localStorage.getItem('session-analytics-shortcuts')`), "off");
    await browser.key("k", { code: "KeyK", modifiers: 4 });
    await delay(150);
    assert.equal(await browser.evaluate(`document.querySelector('#command-palette').open`), true);
    await browser.key("Escape");

    // URL windows override the default without persisting into the next visit.
    for (const [query, expected] of [["?window=all", "all"], ["?window=7", "7"], ["?window=invalid", "30"], ["", "30"]]) {
      await browser.send("Page.navigate", { url: `${origin}/${query}` });
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if ((await browser.evaluate(`document.querySelector('#sync-context')?.dataset.state`)) === "live" &&
          (await browser.evaluate(`location.search`)) === query) break;
        await delay(50);
      }
      assert.equal(await browser.evaluate(`document.querySelector('#window-segment [aria-pressed="true"]').dataset.windowPreset`), expected);
    }

    for (const query of ["?view=models", ""]) {
      await browser.evaluate(`localStorage.setItem('session-analytics-view', 'models')`);
      await browser.send("Page.navigate", { url: `${origin}/${query}` });
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if ((await browser.evaluate(`document.querySelector('#sync-context')?.dataset.state`)) === "live" &&
          (await browser.evaluate(`location.search`)) === query) break;
        await delay(50);
      }
      assert.equal(await browser.evaluate(`document.querySelector('[data-view-panel="costs"]').hidden`), false);
    }

    // Icon rail keeps every view name in the accessibility tree and shows a hover label.
    await browser.send("Emulation.setDeviceMetricsOverride", { deviceScaleFactor: 1, height: 1100, mobile: false, width: 900 });
    await delay(200);
    assert.equal(await browser.evaluate(`getComputedStyle(document.querySelector('[data-view-button="costs"] span')).position`), "absolute");
    assert.equal(await browser.evaluate(`document.querySelector('[data-view-button="costs"]').textContent.trim()`), "CostsG C");
    assert.equal(await browser.evaluate(`getComputedStyle(document.querySelector('[data-view-button="costs"]'), '::after').content`), '"Costs"');
    assert.equal(await browser.evaluate(`getComputedStyle(document.querySelector('.repository-select-wrap')).display`), "block");
  } finally {
    close();
    await stop(chrome);
    await stop(server);
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});
