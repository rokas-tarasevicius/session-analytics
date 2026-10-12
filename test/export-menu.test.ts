import assert from "node:assert/strict";
import test from "node:test";
import { installExportMenu } from "../src/public/export-menu.js";
import { validateSharedSnapshot } from "../src/interop/sharing.ts";
import type { MachineAnalytics, SharedSnapshot } from "../src/types.ts";
import { renderSharedSnapshot } from "../src/public/shared-view.js";

// Browser API adapter tests: exercise real handlers and Blob payloads without a browser dependency.
// Layout, native downloads and full-page rendering still require browser QA.
class Element extends EventTarget {
  dataset: Record<string, string> = {};
  disabled = false;
  hidden = false;
  open = false;
  focused = false;
  textContent = "";
  href = "";
  download = "";
  children: Element[] = [];
  append(...children: Element[]): void { this.children.push(...children); }
  replaceChildren(...children: Element[]): void { this.children = children; }
  setAttribute(): void {}
  remove(): void {}
  focus(): void { this.focused = true; }
  click(): void { if (!this.disabled) this.dispatchEvent(new Event("click")); }
  querySelectorAll(): Element[] { return this.children; }
  querySelector(): Element { return this.children[0]!; }
}

test("export menu disables unloaded/unsupported formats, downloads exactly the shared preview, and closes on Escape", async () => {
  const document = new Element(), menu = new Element(), status = new Element(), description = new Element(), summary = new Element();
  const buttons = ["json", "sessions", "daily", "models", "tools", "shared"].map((kind) => { const button = new Element(); button.dataset.export = kind; return button; });
  menu.children = buttons;
  menu.querySelector = () => summary;
  const downloads: Array<{ name: string; blob: Blob }> = [];
  const blobs = new Map<string, Blob>();
  const adapter = Object.assign(document, {
    body: new Element(),
    querySelector: (selector: string) => ({ "#export-menu": menu, "#export-status": status, "#export-description": description })[selector],
    createElement: () => {
      const link = new Element();
      link.click = () => { downloads.push({ name: link.download, blob: blobs.get(link.href)! }); };
      return link;
    },
  });
  const originalDocument = (globalThis as any).document;
  const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
  (globalThis as any).document = adapter;
  URL.createObjectURL = (blob) => { const url = `blob:synthetic-${blobs.size}`; blobs.set(url, blob); return url; };
  URL.revokeObjectURL = () => {};
  try {
    let selection: MachineAnalytics | SharedSnapshot | null = null;
    const reset = installExportMenu(() => selection) as unknown as () => void;
    menu.open = true;
    menu.dispatchEvent(new Event("toggle"));
    assert.ok(buttons.every((button) => button.disabled));
    selection = {
      schemaVersion: 1, kind: "shared", minimumSessions: 5, sources: [], repositories: [],
      summary: { sessions: 0, inputTokens: 0, outputTokens: 0, pricedTokens: 0, priceableTokens: 0, apiEquivalentSpendUsd: 0, providerReportedSpendUsd: 0, estimatedUpperSpendUsd: 0, toolCalls: 0, compactions: 0 },
    };
    menu.dispatchEvent(new Event("toggle"));
    assert.equal(buttons[0]!.disabled, false); assert.equal(buttons[1]!.disabled, true); assert.equal(buttons[5]!.hidden, false);
    buttons[0]!.click();
    assert.equal(downloads[0]!.name, "shared.json");
    assert.deepEqual(validateSharedSnapshot(JSON.parse(await downloads[0]!.blob.text())), selection);
    menu.open = true; menu.dispatchEvent(new Event("toggle")); buttons[5]!.click();
    assert.equal(downloads[1]!.name, "shared.csv"); assert.match(await downloads[1]!.blob.text(), /^"schemaVersion","repository"/);
    assert.equal(menu.open, false); assert.match(status.textContent, /No data was uploaded/);
    const escape = new Event("keydown"); Object.assign(escape, { key: "Escape" });
    document.dispatchEvent(escape); assert.equal(summary.focused, false);
    menu.open = true; document.dispatchEvent(escape); assert.equal(menu.open, false); assert.equal(summary.focused, true);

    // A changed selection is rejected even if the caller missed a render/reset notification.
    menu.open = true; menu.dispatchEvent(new Event("toggle"));
    const shared = selection;
    const full = { ...shared, sessions: [], kind: undefined } as unknown as MachineAnalytics;
    selection = full;
    const downloadCount = downloads.length;
    buttons[0]!.click();
    assert.equal(downloads.length, downloadCount);
    assert.equal(menu.open, false);
    assert.equal(description.textContent, "");
    assert.equal(status.textContent, "Selection changed; reopen Export");

    // Loading completion, filter changes, and both file-kind transitions close
    // the menu and invalidate controls until a new preview is opened.
    for (const next of [null, full, shared, full, { ...full, sessions: [] }]) {
      menu.open = true; menu.dispatchEvent(new Event("toggle"));
      selection = next; reset();
      assert.equal(menu.open, false);
      assert.ok(buttons.every((button) => button.disabled));
      assert.equal(description.textContent, "");
      const count = downloads.length;
      for (const button of buttons) button.dispatchEvent(new Event("click"));
      assert.equal(downloads.length, count);
      menu.open = true; menu.dispatchEvent(new Event("toggle"));
      if (next === null) assert.match(description.textContent, /loading/);
      else if (next === shared) assert.match(description.textContent, /Shared aggregates only/);
      else { assert.match(description.textContent, /repository names and session keys/); assert.equal(buttons[5]!.disabled, true); }
      // Bypass DOM disabled controls to test the handler's compatibility guard.
      const incompatible = next === shared ? buttons[1]! : buttons[5]!;
      incompatible.dispatchEvent(new Event("click"));
      assert.equal(downloads.length, count);
    }
  } finally { (globalThis as any).document = originalDocument; URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; }
});

test("a dashboard selection states its value basis and downloads the activity ledger it describes as daily.csv", async () => {
  const document = new Element(), menu = new Element(), status = new Element(), description = new Element(), summary = new Element();
  const buttons = ["json", "sessions", "daily", "models", "tools", "shared"].map((kind) => { const button = new Element(); button.dataset.export = kind; return button; });
  menu.children = buttons; menu.querySelector = () => summary;
  const downloads: Array<{ name: string; blob: Blob }> = [];
  const blobs = new Map<string, Blob>();
  const adapter = Object.assign(document, {
    body: new Element(),
    querySelector: (selector: string) => ({ "#export-menu": menu, "#export-status": status, "#export-description": description })[selector],
    createElement: () => { const link = new Element(); link.click = () => { downloads.push({ name: link.download, blob: blobs.get(link.href)! }); }; return link; },
  });
  const originalDocument = (globalThis as any).document;
  const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
  (globalThis as any).document = adapter;
  URL.createObjectURL = (blob) => { const url = `blob:synthetic-${blobs.size}`; blobs.set(url, blob); return url; };
  URL.revokeObjectURL = () => {};
  try {
    const cell = (day: string, value: number) => [day, 9, 0, [value, 10, 10, 0, 0, 2, 0, 1, 0, 0, 12, 0, 10, 0]];
    // Started before the window: its whole-session rows are not in the snapshot, but its in-window value is in daily.csv.
    const earlier = { repositoryId: "r", repositoryName: "Repo", provider: "claude", costBasis: "provider-reported", velocity: { dimensions: [{ agent: "claude-sdk", model: "m", executionKind: "top-level", effort: "unknown" }], buckets: [], undated: [], sessionDated: [cell("2026-09-02", 3)] } };
    const inside = { ...earlier, costBasis: "api-list-price-equivalent", velocity: { ...earlier.velocity, buckets: [cell("2026-09-01", 1), cell("2026-08-31", 50)], sessionDated: [] } };
    const snapshot = { schemaVersion: 1, sessions: [], repositories: [] } as unknown as MachineAnalytics;
    let current: unknown = { snapshot, ledger: { sessions: [earlier, inside], start: "2026-09-01", end: "2026-09-02" }, basis: "Daily value CSV: $4.00 usage value by activity date." };
    installExportMenu(() => current as MachineAnalytics);
    menu.open = true; menu.dispatchEvent(new Event("toggle"));
    assert.match(description.textContent, /^0 sessions in the current repository, date, and view filters\. Daily value CSV: \$4\.00 usage value by activity date\. Downloads include/);
    // Losing the selection invalidates the preview at download time too.
    const selection = current;
    current = null;
    buttons[2]!.click();
    assert.equal(downloads.length, 0); assert.equal(menu.open, false);
    assert.equal(status.textContent, "Selection changed; reopen Export");
    current = selection; menu.open = true; menu.dispatchEvent(new Event("toggle")); buttons[2]!.click();
    assert.equal(downloads[0]!.name, "daily.csv");
    const rows = (await downloads[0]!.blob.text()).trim().split("\r\n").map((line) => line.split(","));
    assert.deepEqual(rows.slice(1).map((row) => [row[4], row[5], row[6], row[7]]), [['"2026-09-01"', '"1"', '"1"', '"0"'], ['"2026-09-02"', '"1"', '"0"', '"3"']]);
    menu.open = true; current = { snapshot, ledger: null, basis: null }; menu.dispatchEvent(new Event("toggle")); buttons[0]!.click();
    assert.deepEqual(JSON.parse(await downloads[1]!.blob.text()), snapshot, "JSON is the snapshot itself, never the wrapper");
  } finally { (globalThis as any).document = originalDocument; URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; }
});

test("review: shared totals disclose running/partial lower bounds and pricing coverage limits", () => {
  const panel = new Element();
  const original = (globalThis as any).document;
  (globalThis as any).document = {
    querySelector: (selector: string) => selector === "#shared-snapshot" ? panel : new Element(),
    querySelectorAll: () => [], createElement: () => new Element(),
  };
  try {
    renderSharedSnapshot({ schemaVersion: 1, kind: "shared", minimumSessions: 5, sources: [], repositories: [], summary: { sessions: 0, inputTokens: 0, outputTokens: 0, pricedTokens: 0, priceableTokens: 0, apiEquivalentSpendUsd: 0, providerReportedSpendUsd: 0, estimatedUpperSpendUsd: 0, toolCalls: 0, compactions: 0 } });
    const text = (element: Element): string => element.textContent + element.children.map(text).join(" ");
    assert.match(text(panel), /observed lower bounds/i);
    assert.match(text(panel), /running and partially parsed sessions/);
    assert.match(text(panel), /Pricing coverage.*evidence completeness/);
  } finally { (globalThis as any).document = original; }
});
