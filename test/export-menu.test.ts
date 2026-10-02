import assert from "node:assert/strict";
import test from "node:test";
import { installExportMenu } from "../src/public/export-menu.js";
import { validateSharedSnapshot } from "../src/interop/sharing.ts";
import type { SharedSnapshot } from "../src/types.ts";

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
  append(child: Element): void { this.children.push(child); }
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
    let selection: SharedSnapshot | null = null;
    installExportMenu(() => selection);
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
    buttons[5]!.click();
    assert.equal(downloads[1]!.name, "shared.csv"); assert.match(await downloads[1]!.blob.text(), /^"schemaVersion","repository"/);
    assert.equal(menu.open, false); assert.match(status.textContent, /No data was uploaded/);
    const escape = new Event("keydown"); Object.assign(escape, { key: "Escape" });
    document.dispatchEvent(escape); assert.equal(summary.focused, false);
    menu.open = true; document.dispatchEvent(escape); assert.equal(menu.open, false); assert.equal(summary.focused, true);
  } finally { (globalThis as any).document = originalDocument; URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; }
});
