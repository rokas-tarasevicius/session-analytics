import assert from "node:assert/strict";
import test from "node:test";
import { summarizeWorkflow } from "../src/public/workflow-data.js";
import type { MachineAnalytics, SessionAnalytics } from "../src/types.ts";
import type { WorkflowWorker } from "../src/public/workflow-scope.js";
import { workflowScaleFixture } from "./workflow-scale-fixture.ts";

// A small DOM contract harness; real layout/CSP checks use the demo browser.
class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  listeners = new Map<string, () => unknown>();
  value = "all";
  ownText = "";
  className = "";
  tag: string;
  constructor(tag: string) { this.tag = tag; }
  set textContent(value: unknown) { this.ownText = String(value); this.children = []; }
  get textContent(): string { return this.ownText + this.children.map((c) => c.textContent).join(" "); }
  append(...items: Element[]) { this.children.push(...items); }
  replaceChildren(...items: Element[]) { this.ownText = ""; this.children = items; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); if (name.startsWith("data-")) this.dataset[name.slice(5)] = value; }
  getAttribute(name: string) { return this.attributes.get(name); }
  addEventListener(name: string, listener: () => unknown) { this.listeners.set(name, listener); }
  querySelector(selector: string): Element | undefined { return this.querySelectorAll(selector)[0]; }
  querySelectorAll(selector: string): Element[] { return this.children.flatMap((c) => [...(c.tag === selector || selector === "[data-day]" && c.dataset.day ? [c] : []), ...c.querySelectorAll(selector)]); }
}

function dom() {
  const content = new Element("div"), provider = new Element("select");
  Object.assign(globalThis, { document: {
    querySelector: (selector: string) => selector === "#workflow-content" ? content : provider,
    createElement: (tag: string) => new Element(tag), createElementNS: (_ns: string, tag: string) => new Element(tag),
    createTextNode: (text: string) => { const e = new Element("text"); e.textContent = text; return e; },
  }, Option: class extends Element { constructor(label: string, value: string) { super("option"); this.textContent = label; this.value = value; } } });
  return { content, provider };
}

test("review 6: full-machine Workflow visits use the supplied aggregate without reading 5,052 workflows", async () => {
  const { content } = dom();
  const sessions = Array.from({ length: 5052 }, (_, index) => ({ sessionKey: String(index), repositoryId: "repo", provider: "codex", get workflow() { throw new Error("unnecessary workflow recomputation"); } } as SessionAnalytics));
  const snapshot = { sessions, generatedAt: "2026-06-01T00:00:00Z", repositories: [{ repository: { id: "repo", name: "Synthetic" } }], workflow: summarizeWorkflow([]) } as unknown as MachineAnalytics;
  const { renderWorkflow } = await import("../src/public/workflow.js");
  const view = { sessions, repositories: snapshot.repositories };
  await renderWorkflow(view, snapshot); await renderWorkflow({ ...view, sessions: sessions.slice() }, snapshot);
  assert.match(content.textContent, /0\/0 sessions supported/);
});

test("review 7: an empty session scope still renders its discovered unused inventory", async () => {
  const { content } = dom();
  const workflow = summarizeWorkflow([]);
  workflow.installedSkills = [{ name: "quiet-skill", provider: "claude", repositoryId: "repo", observedInvocations: 0 }];
  const snapshot = { sessions: [], repositories: [{ repository: { id: "repo", name: "Synthetic" } }], workflow, generatedAt: "2026-06-01T00:00:00Z" } as unknown as MachineAnalytics;
  const { renderWorkflow } = await import("../src/public/workflow.js");
  await renderWorkflow({ sessions: [], repositories: snapshot.repositories }, snapshot);
  assert.match(content.textContent, /No sessions/);
  assert.match(content.textContent, /quiet-skill/);
  assert.match(content.textContent, /1\/1 provider-and-scope installations/);
});

test("review 6/7: filtered views show pending state, render empty-window inventory, and ignore stale responses", async () => {
  const { content } = dom(), { snapshot, inventory } = workflowScaleFixture(10);
  const requests: Array<{ id: number; worker: WorkflowWorker }> = [];
  const instances: WorkflowWorker[] = [];
  Object.assign(globalThis, { Worker: class implements WorkflowWorker {
    onmessage: WorkflowWorker["onmessage"] = null;
    onerror: WorkflowWorker["onerror"] = null;
    constructor() { instances.push(this); }
    terminate() {}
    postMessage(message: unknown) {
      const data = message as { type: string; id: number };
      if (data.type === "select") requests.push({ id: data.id, worker: this });
    }
  } });
  const { renderWorkflow, clearWorkflow } = await import("../src/public/workflow.js");
  const repositories = snapshot.repositories.filter((r) => r.repository.id === "repo-0");
  const first = renderWorkflow({ sessions: snapshot.sessions.slice(0, 1), repositories }, snapshot);
  assert.match(content.textContent, /Calculating workflow/); assert.equal(content.getAttribute("aria-busy"), "true");
  const second = renderWorkflow({ sessions: [], repositories }, snapshot);
  for (let n = 0; n < 200 && requests.length < 2; n += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(requests.length, 2);
  const empty = summarizeWorkflow([], inventory, snapshot.generatedAt, ["repo-0"]);
  requests[1]!.worker.onmessage!({ data: { id: requests[1]!.id, result: empty } }); await second;
  assert.match(content.textContent, /No sessions/); assert.match(content.textContent, /repo-skill/);
  assert.match(content.textContent, /4\/4 provider-and-scope installations/);
  assert.equal(content.getAttribute("aria-busy"), "false");
  requests[0]!.worker.onmessage!({ data: { id: requests[0]!.id, result: snapshot.workflow! } }); await first;
  assert.match(content.textContent, /No sessions/, "a slow prior scope cannot replace the selected scope");
  const leftTab = renderWorkflow({ sessions: [], repositories: [] }, snapshot);
  clearWorkflow(); content.replaceChildren();
  for (let n = 0; n < 200 && requests.length < 3; n += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  requests[2]!.worker.onmessage!({ data: { id: requests[2]!.id, result: empty } }); await leftTab;
  assert.equal(content.textContent, "", "leaving the tab must invalidate pending rendering");
  const failure = renderWorkflow({ sessions: snapshot.sessions.slice(2), repositories }, snapshot);
  for (let n = 0; n < 200 && requests.length < 4; n += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  instances[0]!.onerror!(); await failure;
  assert.match(content.textContent, /calculation is unavailable/); assert.equal(content.getAttribute("aria-busy"), "false");
});

test("review 6: rendering a supplied aggregate preserves cached ordering and metadata", async () => {
  dom(); const { snapshot } = workflowScaleFixture(100);
  const freeze = (value: unknown): void => {
    if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  };
  freeze(snapshot.workflow);
  const { renderWorkflow } = await import("../src/public/workflow.js");
  await renderWorkflow({ sessions: snapshot.sessions, repositories: snapshot.repositories }, snapshot);
});
