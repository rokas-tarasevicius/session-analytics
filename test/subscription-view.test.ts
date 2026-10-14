// Subscription view rendering with the dependency-free DOM contract: hierarchy, urgency order, the exclude-from-totals
// control, and state that must survive the two-minute refresh (focus keys, the inspected reading, open disclosures).
import assert from "node:assert/strict";
import test from "node:test";

import type { LimitAccount, LimitObservation, LimitsSnapshot } from "../src/limits/types.ts";
import { Element, documentFromHtml } from "./release-dom.ts";
import { harness, sample } from "./validation/aggregation-ui-harness.ts";

const globals = globalThis as unknown as Record<string, unknown>;
globals["document"] = documentFromHtml("");
const settings = new Map<string, string>();
globals["localStorage"] = { getItem: (key: string) => settings.get(key) ?? null, setItem: (key: string, value: string) => settings.set(key, value), removeItem: (key: string) => settings.delete(key) };
const { renderSubscription } = await import(new URL("../src/public/subscription.js", import.meta.url).href);

const at = (iso: string) => Date.parse(iso) / 1000;
const HOUR = 3600, DAY = 86_400;
const now = at("2026-10-14T12:00:00Z");
const team = "claude-aaaaaaaaaaaaaaaa", max = "claude-bbbbbbbbbbbbbbbb", codex = "codex-cccccccccccccccc";

function account(key: string, provider: "claude" | "codex", label: string, plan: LimitAccount["plan"]): LimitAccount {
  return { key, provider, attribution: "account", label, profileNames: [label.split(" · ")[1]!], profileKeys: [], plan, planSource: null, planEvidence: null, extraUsage: null, codex: null, weeklyAnchor: null, lastSeen: now };
}
const reading = (provider: "claude" | "codex", accountKey: string, meter: string, resetsAt: number, observedAt: number, usedPercent: number, status: LimitObservation["status"] = "allowed"): LimitObservation =>
  ({ provider, account: accountKey, meter, windowMinutes: meter === "five_hour" ? 300 : 10_080, resetsAt, observedAt, usedPercent, status, source: provider === "codex" ? "codex-session" : "claude-sdk-log" });

/** A Team seat used up on Tuesday, a Max plan on track with a 5-hour window, and a Codex account on track. */
function limits(): LimitsSnapshot {
  const teamReset = at("2026-10-16T03:00:00Z"), maxReset = at("2026-10-19T10:00:00Z"), codexReset = at("2026-10-17T20:00:00Z");
  const observations = [
    ...[10, 35, 60, 85, 99].map((level, index) => reading("claude", team, "seven_day", teamReset, teamReset - 7 * DAY + (index + 1) * 18 * HOUR, level)),
    reading("claude", team, "seven_day", teamReset, now - 2 * HOUR, 100, "rejected"),
    ...[4, 9, 14].map((level, index) => reading("claude", max, "seven_day", maxReset, maxReset - 7 * DAY + (index + 1) * 16 * HOUR, level)),
    reading("claude", max, "seven_day", maxReset, now - 20 * 60, 16),
    reading("claude", max, "five_hour", now + 3 * HOUR, now - 2 * HOUR, 20), reading("claude", max, "five_hour", now + 3 * HOUR, now - 20 * 60, 30),
    ...[10, 25, 40].map((level, index) => reading("codex", codex, "seven_day", codexReset, codexReset - 7 * DAY + (index + 1) * DAY, level)),
    reading("codex", codex, "seven_day", codexReset, now - HOUR, 45),
  ];
  return {
    schemaVersion: 2, generatedAt: new Date(now * 1000).toISOString(), dataSource: "live", persisted: true, ledger: "ok", plans: { claude: null, codex: null },
    sources: [{ source: "claude-sdk-log", status: "ok", read: 3, latest: now - 20 * 60 }, { source: "codex-session", status: "ok", read: 1, latest: now - HOUR }],
    observations, meters: [], resetCreditHistory: [], codexAccount: "off",
    accounts: [account(max, "claude", "Claude Max 20x · personal", "max-20x"), account(team, "claude", "Claude Team · work", "team"), account(codex, "codex", "ChatGPT Pro 200 · default", "pro")],
  };
}

const render = (container: Element, options: Record<string, unknown> = {}) =>
  renderSubscription(container, { limits: limits(), sessions: [], timeZone: "UTC", displayTimeZone: "UTC", range: { from: now - 30 * DAY, to: now }, now, wide: true, ...options });
const descendants = (node: Element): Element[] => node.children.flatMap((child) => [child, ...descendants(child)]);
const cardOf = (container: Element, key: string) => container.querySelectorAll(".subscription-card").find((card) => card.dataset["account"] === key)!;

test("limits come first, one row per account, most urgent first; then next steps, cards, value, history and sources", () => {
  const container = new Element();
  render(container);
  assert.deepEqual(container.children.map((child) => child.className.split(" ").at(-1)),
    ["limits-now", "subscription-next", "subscription-cards", "subscription-worth", "subscription-history", "subscription-sources"]);
  const rows = container.querySelectorAll(".limit-row");
  assert.deepEqual(rows.map((row) => row.querySelector(".limit-account")!.textContent.trim()), ["Claude Team · work", "ChatGPT Pro 200 · default", "Claude Max 20x · personal"]);
  assert.match(rows[0]!.querySelector(".status-chip")!.textContent, /^Capped until Fri 03:00/);
  assert.equal(rows[0]!.querySelector(".limit-left")!.querySelector("strong")!.textContent, "0%");
  assert.match(rows[0]!.querySelector(".limit-reset")!.textContent, /^Resets Fri 03:00 · in 39h/);
  assert.equal(rows[2]!.querySelector(".limit-left")!.querySelector("strong")!.textContent, "84%");
  assert.ok(descendants(container).filter((node) => node.tagName === "svg").every((node) => node.className === "subscription-chart"), "every chart opts out of the icon stroke");
  assert.ok(container.querySelectorAll("details").every((details) => details.querySelector("summary")?.dataset["focusKey"]), "every disclosure is keyboard reachable and keeps focus");
});

test("excluding an account from value totals keeps its card, its meters and the control that undoes it", () => {
  settings.clear();
  const container = new Element();
  let changes = 0;
  render(container, { onPlanChange: () => { changes += 1; } });
  const select = cardOf(container, codex).querySelector("select")!;
  assert.equal(select.dataset["focusKey"], `plan:${codex}`);
  assert.ok(select.options.some((option) => option.value === "none" && /Exclude from value totals/.test(option.textContent)));
  select.value = "none";
  select.listeners.get("change")!();
  assert.equal(changes, 1);
  assert.equal(settings.get(`session-analytics.subscription-plan.${codex}`), "none");
  render(container);
  const card = cardOf(container, codex);
  assert.equal(card.dataset["excluded"], "true");
  assert.equal(card.querySelector("select")!.value, "none", "the same control shows the choice and can undo it");
  assert.match(card.textContent, /Excluded from value totals/);
  assert.ok(card.querySelector(".meter-row"), "its meters still show");
  assert.equal(container.querySelectorAll(".limit-row").length, 3, "it stays in Limits now");
  assert.match(container.querySelector(".subscription-worth")!.textContent, /Excluded from totals: ChatGPT Pro 200 · default/);
  card.querySelector("select")!.value = "";
  card.querySelector("select")!.listeners.get("change")!();
  assert.equal(settings.has(`session-analytics.subscription-plan.${codex}`), false);
  settings.clear();
});

test("a refresh keeps the inspected reading, open disclosures and focus keys of the charts", () => {
  const container = new Element();
  render(container);
  const chart = () => cardOf(container, team).querySelector(".burn-chart")!.querySelector("svg")!;
  const readout = () => cardOf(container, team).querySelector(".subscription-readout")!.textContent;
  assert.equal(chart().getAttribute("data-focus-key"), `chart:burn:${team}`);
  assert.equal(chart().getAttribute("tabindex"), "0");
  const latest = readout();
  for (let step = 0; step < 2; step += 1) chart().listeners.get("keydown")!({ key: "ArrowLeft", preventDefault() {} });
  const inspected = readout();
  assert.notEqual(inspected, latest);
  const sources = container.querySelector(".subscription-sources")!.querySelector("details")!;
  sources.open = true;
  sources.listeners.get("toggle")!();
  render(container);
  assert.equal(readout(), inspected, "the reading stays inspected after a refresh");
  assert.equal(container.querySelector(".subscription-sources")!.querySelector("details")!.open, true, "an opened disclosure stays open");
});

test("before the session scan finishes, the meters render and value says it is calibrating; saved snapshots explain where limits live", () => {
  const container = new Element();
  render(container, { sessions: null, range: null });
  assert.equal(container.querySelectorAll(".limit-row").length, 3);
  assert.match(container.querySelector(".subscription-worth")!.textContent, /Calibrating from history/);
  render(container, { limits: { ...limits(), dataSource: "snapshot" } });
  assert.match(container.textContent, /live-only.*Run `session-analytics limits` on the machine that recorded this snapshot/);
  render(container, { limits: { ...limits(), accounts: [], observations: [], sources: [] } });
  assert.match(container.textContent, /No limit readings yet.*status line/);
});

test("the dashboard shows the meters before the session snapshot arrives, and a refresh puts focus back on the redrawn chart", async () => {
  const { run, context, document } = await harness([sample()]);
  context["fixtureLimits"] = limits();
  run("snapshot = null; limits = fixtureLimits; renderSubscriptionView()");
  const view = () => document.querySelector("#subscription-view")!;
  assert.equal(view().querySelectorAll(".limit-row").length, 3);
  assert.match(view().querySelector(".subscription-worth")!.textContent, /Calibrating from history/);
  const focus = Element.prototype.focus;
  Element.prototype.focus = function (this: Element) { (document as unknown as { activeElement: Element }).activeElement = this; };
  try {
    const chart = view().querySelectorAll("svg").find((node) => node.getAttribute("data-focus-key") === `chart:burn:${team}`)!;
    (document as unknown as { activeElement: Element }).activeElement = chart;
    chart.isConnected = false;
    run("snapshot = fixture; renderSubscriptionView()");
    const active = (document as unknown as { activeElement: Element }).activeElement;
    assert.notEqual(active, chart, "the chart was redrawn");
    assert.equal(active.getAttribute("data-focus-key"), `chart:burn:${team}`, "focus moves to its replacement");
  } finally { Element.prototype.focus = focus; }
});
