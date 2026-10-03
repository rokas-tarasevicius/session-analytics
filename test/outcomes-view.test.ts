import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { enrichmentStatuses, mergedOutcomeRefs, outcomeEvidence, summarizeOutcomes } from "../src/metrics/outcomes-summary.js";
import { OutcomeCollector } from "../src/metrics/outcomes.ts";
import type { SessionAnalytics, SessionDatabaseRow } from "../src/types.ts";

/** Minimal DOM boundary to exercise the real view and event handlers without a browser dependency. */
class Element {
  tagName: string;
  children: Element[] = [];
  attributes = new Map<string, string>();
  events = new Map<string, () => void>();
  private ownText = "";
  className = "";
  value = "";
  id = "";
  disabled = false;
  scrolled = false;
  constructor(tag: string) { this.tagName = tag; }
  set textContent(value: string) { this.ownText = String(value); this.children = []; }
  get textContent(): string { return this.ownText + this.children.map((child) => child.textContent).join(" "); }
  get childNodes() { return this.children; }
  append(...children: Element[]) { this.children.push(...children); }
  prepend(...children: Element[]) { this.children.unshift(...children); }
  replaceChildren(...children: Element[]) { this.ownText = ""; this.children = children; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  addEventListener(name: string, callback: () => void) { this.events.set(name, callback); }
  scrollIntoView() { this.scrolled = true; }
  querySelector(selector: string): Element | null { return this.all().find((child) => selector.startsWith("#") ? child.id === selector.slice(1) : child.tagName === selector) ?? null; }
  all(): Element[] { return this.children.flatMap((child) => [child, ...child.all()]); }
  fire(name: string) { this.events.get(name)?.(); }
}
class Option extends Element {
  constructor(label: string, value: string) { super("option"); this.textContent = label; this.value = value; }
}
async function view() {
  const source = (await readFile(new URL("../src/public/outcomes.js", import.meta.url), "utf8"))
    .replace(/^import .*;\n/m, "").replace("export function renderOutcomes", "function renderOutcomes");
  const context = { document: { createElement: (tag: string) => new Element(tag) }, Option, enrichmentStatuses, mergedOutcomeRefs, outcomeEvidence, summarizeOutcomes };
  const render = runInNewContext(`${source}\nrenderOutcomes;`, context) as (container: Element, sessions: SessionAnalytics[]) => void;
  return { render, container: new Element("div") };
}
function sample(provider: "claude" | "codex", index: number, action?: string): SessionAnalytics {
  const collector = new OutcomeCollector({ repository_id: "demo-repo", conductor_session_id: `sample-${index}` } as SessionDatabaseRow);
  if (action) collector.observeClaude({ type: "user", toolUseResult: { gitOperation: { pr: { url: "https://github.com/example/demo/pull/1", action } } }, message: { content: [{ type: "tool_result", tool_use_id: `call-${index}` }] } });
  return { sessionKey: `key-${index}`, repositoryId: "demo-repo", repositoryName: "<img src=x onerror=private-sentinel>", provider, createdAt: "2026-09-01T12:00:00.000Z", outcomes: collector.project(),
    cost: { totalUsd: 2 }, costBasis: "api-list-price-equivalent", costComplete: true, pricedTokenCoverage: 1 } as SessionAnalytics;
}

test("Outcomes view renders coverage, pseudonymous evidence, literal names, empty states, and guarded ratios", async () => {
  const { render, container } = await view();
  render(container, [sample("claude", 1, "created"), sample("claude", 2, "merged")]);
  assert.match(container.textContent, /2\/2 sessions inspected/);
  assert.match(container.textContent, /N\/A/); assert.match(container.textContent, /not an invoice/);
  assert.match(container.textContent, /<img src=x onerror=private-sentinel>/);
  assert.equal(container.all().filter((element) => element.tagName === "img").length, 0);
  assert.doesNotMatch(container.textContent, /github\.com|example\/demo/);
  assert.equal(container.all().filter((element) => element.tagName === "meter").length, 5);
  render(container, []);
  assert.match(container.textContent, /No sessions match/); assert.doesNotMatch(container.textContent, /NaN|Infinity/);
});

test("stage drilldown agrees with cross-session merged PR totals and supports paging and provider filtering", async () => {
  const { render, container } = await view();
  const sessions = Array.from({ length: 22 }, (_, index) => sample(index === 0 ? "codex" : "claude", index, index === 1 ? "merged" : "created"));
  render(container, sessions);
  const stages = container.all().filter((element) => element.className === "outcome-stage");
  assert.match(stages[4]!.textContent, /22\/22 sessions/);
  stages[4]!.fire("click");
  const evidence = container.querySelector("#outcome-session-evidence")!;
  assert.equal(evidence.scrolled, true);
  assert.match(evidence.textContent, /1–20 of 22 sessions/);
  const next = evidence.all().find((element) => element.tagName === "button" && element.textContent === "Next")!;
  assert.equal(next.disabled, false); next.fire("click");
  assert.match(container.querySelector("#outcome-session-evidence")!.textContent, /21–22 of 22 sessions/);
  const selector = container.all().find((element) => element.tagName === "select")!;
  selector.value = "codex"; selector.fire("change");
  assert.match(container.textContent, /1\/1 sessions inspected/);
  // The merge observation was in the now-excluded Claude session. State must
  // not leak from a prior filter's aggregate into the current provider cohort.
  assert.match(container.textContent, /No sessions have this evidence/);
});

test("commit and unlinked drilldowns retain operation evidence after the detail cap", async () => {
  const { render, container } = await view();
  const collector = new OutcomeCollector({ repository_id: "demo-repo", conductor_session_id: "synthetic-cap" } as SessionDatabaseRow);
  for (let number = 1; number <= 128; number++) collector.observeClaude({ type: "pr-link", prUrl: `https://github.com/example/demo/pull/${number}` });
  collector.observeClaude({ type: "user", toolUseResult: { structuredPatch: [{ lines: ["+private-content-sentinel"] }], gitOperation: { commit: { sha: "a".repeat(40), kind: "committed" } } }, message: { content: [{ type: "tool_result", tool_use_id: "cap-commit" }] } });
  const session = sample("claude", 1); session.outcomes = collector.project();
  render(container, [session]);
  const commits = container.all().filter((element) => element.className === "outcome-stage")[2]!;
  assert.match(commits.textContent, /1\/1 sessions/); commits.fire("click");
  const evidence = container.querySelector("#outcome-session-evidence")!;
  assert.match(evidence.textContent, /1–1 of 1 sessions/);
  assert.match(evidence.textContent, /Commit operation recorded; link details were truncated/);
  const select = evidence.all().find((element) => element.tagName === "select")!;
  select.value = "unlinked"; select.fire("change");
  assert.match(container.querySelector("#outcome-session-evidence")!.textContent, /No sessions have this evidence/);
  assert.doesNotMatch(container.textContent, /private-content-sentinel|example\/demo/);
});

test("dashboard withholds allocation ratios for incomplete PR associations", async () => {
  const { render, container } = await view();
  const collector = new OutcomeCollector({ repository_id: "demo-repo", conductor_session_id: "synthetic-ratio" } as SessionDatabaseRow);
  for (let number = 1; number <= 129; number++) collector.observeClaude({ type: "user", toolUseResult: { gitOperation: { pr: { url: `https://github.com/example/demo/pull/${number}`, action: number <= 3 ? "merged" : "created" } } }, message: { content: [{ type: "tool_result", tool_use_id: `pr-${number}` }] } });
  const session = sample("claude", 1); session.outcomes = collector.project();
  render(container, [session]);
  assert.match(container.textContent, /Incomplete PR associations; ratio withheld/);
  assert.match(container.textContent, /1 sessions with incomplete evidence/);
});
