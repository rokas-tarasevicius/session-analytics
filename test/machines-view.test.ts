// The Machines strip, its dialog, the machine filter and the coverage notes that name machines.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { remoteUnavailableWarning, staleMachineWarning } from "../src/public/evidence.js";
import { machineAge, machineNote, machineReasons, machineView, machineWarnings } from "../src/public/machines.js";
import type { MachineAnalytics, MachineStatus, SessionAnalytics } from "../src/types.ts";
import { harness, sample, withLedger } from "./validation/aggregation-ui-harness.ts";

const cursorMissing = "Cursor local session history is missing.";
const hoursAgo = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString();

function machines(): MachineStatus[] {
  return [
    { key: "local", label: "laptop", state: "ok", sessions: 1, repositories: 1, readAt: hoursAgo(0), durationMs: 31_200, version: "0.9.0" },
    { key: "agentbox", label: "agentbox", state: "stale", reason: "connection", fix: "run ssh agentbox true once in a terminal", sessions: 1, repositories: 1,
      readAt: hoursAgo(2), durationMs: 4_100, version: "0.9.0", warnings: [cursorMissing] },
    { key: "boxa", label: "boxa", state: "failed", reason: "sudo", fix: "allow that command through sudo without a password there", sessions: 0, repositories: 0, readAt: null, durationMs: null, version: null },
  ];
}

function sessions(): SessionAnalytics[] {
  const laptop = withLedger(sample(), [["synthetic", 10]]), server = withLedger(sample(), [["synthetic", 5]]);
  laptop.machine = "local"; server.machine = "agentbox"; server.sessionKey = "000000000002";
  return [laptop, server];
}

async function rendered(list = machines()) {
  const setup = await harness(sessions());
  setup.run(`fixture.rateCard = { effectiveDate: '2026-10-01', models: [] }; fixture.machines = ${JSON.stringify(list)};
    fixture.warnings = ${JSON.stringify([remoteUnavailableWarning, staleMachineWarning, cursorMissing])}; render(fixture); showReady(activeView())`);
  return setup;
}

test("reasons, ages and notes are short and cover every reason", () => {
  assert.equal(Object.keys(machineReasons).length, 28);
  assert.equal(machineAge(null), null);
  assert.equal(machineAge(new Date(Date.now() - 30_000).toISOString()), "just now");
  assert.equal(machineAge(hoursAgo(2)), "2 h ago");
  assert.equal(machineAge(hoursAgo(72)), "3 days ago");
  const [laptop, agentbox, boxa] = machines();
  assert.equal(machineNote(laptop!), "");
  assert.equal(machineNote(agentbox!), "unreachable · showing 2 h ago");
  assert.equal(machineNote(boxa!), "not read: sudo needs a password");
  assert.equal(machineNote({ ...boxa!, state: "reading", reason: undefined }), "reading");
  assert.equal(machineNote({ ...laptop!, sessions: 0, reason: "no-history" }), "no history for this account");
});

test("coverage notes name the machine; one machine's notes stay as they were", () => {
  const notes = machineWarnings(machines(), [remoteUnavailableWarning, staleMachineWarning, cursorMissing, "1 sessions have incomplete token pricing."]);
  assert.deepEqual(notes, [
    `agentbox: ${cursorMissing}`, "1 sessions have incomplete token pricing.",
    "agentbox could not be read (unreachable); its last good snapshot from 2 h ago is used instead.",
    "boxa could not be read (sudo needs a password); its sessions are missing.",
  ]);
  assert.deepEqual(machineWarnings(undefined, [cursorMissing]), [cursorMissing]);
  const twin: MachineStatus = { key: "again", label: "again", state: "failed", reason: "same-machine", sessions: 0, repositories: 0, readAt: null, durationMs: null, version: null };
  assert.match(machineWarnings([machines()[0]!, twin], [])[0]!, /^again is the same machine and account as another one; its sessions are counted once\.$/);
});

test("the machine filter keeps the selected machines' sessions and the repositories they touch", () => {
  const snapshot = { machines: machines(), sessions: sessions(), repositories: [{ repository: { id: "synthetic", name: "Synthetic" } }, { repository: { id: "other", name: "Other" } }], historyCoverage: {} } as unknown as MachineAnalytics;
  const narrowed = machineView(snapshot, new Set(["agentbox"]));
  assert.deepEqual(narrowed.sessions.map(({ machine }) => machine), ["agentbox"]);
  assert.deepEqual(narrowed.repositories.map(({ repository }) => repository.id), ["synthetic"]);
  assert.equal(narrowed.historyCoverage, undefined);
  assert.equal(machineView(snapshot, new Set(["local", "agentbox", "boxa"])), snapshot);
  // A session without a key belongs to the first machine.
  const untagged = { ...snapshot, sessions: snapshot.sessions.map(({ machine: _, ...session }) => session) } as MachineAnalytics;
  assert.equal(machineView(untagged, new Set(["local"])), untagged);
});

test("the strip lists every machine; a failed one opens its reason and fix; the sync label says what is missing", async () => {
  const { document, run, fireKey } = await rendered();
  const strip = document.querySelector("#machine-strip")!;
  assert.equal(strip.hidden, false);
  const chips = document.querySelector("#machine-chips")!.children;
  assert.deepEqual(chips.map((chip) => chip.tagName.toLowerCase()), ["label", "label", "button"]);
  assert.deepEqual(chips.map((chip) => chip.dataset["state"]), ["ok", "stale", "failed"]);
  assert.equal(chips[1]!.querySelector("input")!.getAttribute("aria-label"), "agentbox: 1 sessions, all time, unreachable · showing 2 h ago");
  assert.equal(chips[1]!.getAttribute("title"), "1 sessions read from agentbox, all time");
  assert.equal(chips[2]!.getAttribute("aria-label"), "boxa: not read: sudo needs a password. Show machine details");
  assert.match(document.querySelector("#machine-strip-meta")!.textContent, /^snapshot \d\d:\d\d$/);
  const sync = document.querySelector("#sync-context")!;
  assert.equal(sync.dataset["state"], "warn");
  assert.equal(document.querySelector("#sync-label")!.textContent, "1 of 3 machines ready · boxa not read · agentbox stale");
  chips[2]!.listeners.get("click")!();
  const dialog = document.querySelector("#machines-dialog")!;
  assert.equal(dialog.open, true);
  // Single-key shortcuts wait while the dialog is open.
  fireKey("e");
  assert.equal(document.querySelector("#coverage-dialog")!.open, false);
  const fixes = document.querySelector("#machines-rows")!.querySelectorAll("code").map((code) => code.textContent);
  assert.deepEqual(fixes, ["run ssh agentbox true once in a terminal", "allow that command through sudo without a password there"]);
  const rows = document.querySelector("#machines-rows")!.children.filter((row) => !row.className);
  assert.deepEqual(rows.map((row) => row.children[1]!.textContent), ["read", "unreachable · showing 2 h ago", "not read: sudo needs a password"]);
  assert.deepEqual(rows.map((row) => row.children[5]!.textContent), ["31.2 s", "4.1 s", "—"]);
  run("closeMachines()");
  assert.equal(dialog.open, false);
  const warnings = document.querySelector("#warning-list")!.children.map((item) => item.textContent);
  assert.ok(warnings.includes(`agentbox: ${cursorMissing}`), warnings.join("\n"));
  assert.ok(warnings.some((warning) => /^boxa could not be read \(sudo needs a password\)/.test(warning)));
  assert.ok(!warnings.includes(remoteUnavailableWarning) && !warnings.includes(staleMachineWarning));
  assert.ok(run("paletteItems().some((item) => item.label === 'Machine details')"));
  assert.equal(document.querySelector("#coverage-machines-note")!.hidden, true, "with machines saved, Coverage does not suggest adding one");
});

test("switching a machine off narrows every view, its breakdown and exports, and survives a refresh", async () => {
  const { document, run } = await rendered();
  assert.equal(run("snapshot.sessions.length"), 2);
  assert.equal(document.querySelector("#machine-spend-panel")!.hidden, false);
  // The failed machine has no value to show, not a value of zero.
  assert.equal(document.querySelector("#machine-spend")!.children.length, 2);
  const agentbox = document.querySelector("#machine-chips")!.children[1]!.querySelector("input")!;
  agentbox.checked = false; agentbox.listeners.get("change")!();
  assert.deepEqual(run("snapshot.sessions.map(({ machine }) => machine)"), ["local"]);
  assert.equal(run("fullSnapshot.sessions.length"), 2);
  assert.equal(run("exportSelection().snapshot.sessions.length"), run("activeView().sessions.length"));
  assert.ok(run("exportSelection().snapshot.sessions.every(({ machine }) => machine === 'local')"));
  assert.match(run("exportSelection().basis"), / 2 of 3 machines\.$/);
  assert.equal(document.querySelector("#machine-spend")!.children.length, 1);
  assert.equal(document.querySelector("#machine-chips")!.children[1]!.querySelector("input")!.checked, false);
  run("render(fixture)");
  assert.deepEqual(run("snapshot.sessions.map(({ machine }) => machine)"), ["local"]);
  run("setMachine('agentbox', true)");
  assert.equal(run("snapshot.sessions.length"), 2);
});

test("one machine keeps the plain sync label and no strip, and Coverage says where other machines are added", async () => {
  const { document, run } = await harness(sessions().map(({ machine: _, ...session }) => session));
  run("fixture.rateCard = { effectiveDate: '2026-10-01', models: [] }; render(fixture); showReady(activeView())");
  assert.equal(document.querySelector("#machine-strip")!.hidden, true);
  const hint = document.querySelector("#coverage-machines-note")!;
  assert.equal(hint.hidden, false);
  assert.match(readFileSync(new URL("../src/public/index.html", import.meta.url), "utf8"), /id="coverage-machines-note" hidden>Agents on a server or VM too\? Run <code>session-analytics machines add HOST<\/code>/);
  assert.equal(document.querySelector("#coverage-machines-link")!.getAttribute("href"), "https://github.com/rokas-tarasevicius/session-analytics/blob/master/docs/interop.md#combine-machines");
  assert.equal(document.querySelector("#machine-spend-panel")!.hidden, true);
  assert.match(document.querySelector("#sync-label")!.textContent, /^Local snapshot ready$/);
  assert.equal(document.querySelector("#sync-context")!.dataset["state"], "live");
});

test("while a machine is reading, the dashboard polls /api/machines and fetches the snapshot once it answers", async () => {
  const { context, document, run } = await harness(sessions());
  const ticks: Array<() => void> = [], requests: string[] = [];
  let state = "reading";
  context["setInterval"] = (callback: () => void) => { ticks.push(callback); return ticks.length; };
  context["clearInterval"] = () => {};
  const reading = machines().slice(0, 2).map((machine) => machine.key === "agentbox" ? { ...machine, state: "reading", reason: undefined, fix: undefined } : machine);
  context["fetch"] = async (url: string) => {
    requests.push(url);
    const body = url === "/api/machines" ? { machines: reading.map((machine) => machine.key === "agentbox" ? { ...machine, state } : machine) }
      : { ...context["fixture"] as object, machines: reading.map((machine) => ({ ...machine, state: "ok" })) };
    return { ok: true, json: async () => body };
  };
  run(`fixture.rateCard = { effectiveDate: '2026-10-01', models: [] }; fixture.machines = ${JSON.stringify(reading)}; render(fixture); showReady(activeView())`);
  assert.equal(document.querySelector("#sync-context")!.dataset["state"], "reading");
  assert.match(document.querySelector("#sync-label")!.textContent, /^1 of 2 machines ready · reading agentbox$/);
  assert.equal(document.querySelector("#machine-chips")!.children[1]!.querySelector(".machine-note")!.textContent, "reading · showing 2 h ago");
  assert.equal(ticks.length, 1);
  ticks[0]!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests, ["/api/machines"]);
  state = "ok";
  ticks[0]!();
  for (let attempt = 0; attempt < 5; attempt++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests, ["/api/machines", "/api/machines", "/api/analytics?wait=10"]);
  assert.equal(run("fullSnapshot.machines.every(({ state }) => state === 'ok')"), true);
  assert.match(document.querySelector("#sync-label")!.textContent, /^2 of 2 machines ready$/);
});

test("Subscription counts every machine whose limits and sessions were read, whatever the strip shows, and names the others", async () => {
  const { context, document, run } = await rendered();
  type Options = { sessions: SessionAnalytics[]; scope: { label: string; others: string[]; sessions: Set<string> | null } };
  const calls: Options[] = [];
  context["renderSubscription"] = (_container: unknown, options: Options) => { calls.push(options); };
  context["fetch"] = async () => ({ ok: false, json: async () => ({}) });
  run("setMachine('local', false)");
  assert.equal(run("snapshot.sessions.length"), 1);
  run("switchView('subscription')");
  const { sessions: all, scope } = calls.at(-1)!;
  assert.equal(all.length, 2, "the strip does not narrow Subscription");
  // Without other machines' limits, only this machine's sessions can join an account.
  const { attributeSessions } = await import(new URL("../src/public/subscription-data.js", import.meta.url).href) as typeof import("../src/public/subscription-data.js");
  const accounts = [{ key: "codex-aaaaaaaaaaaaaaaa", provider: "codex", profileKeys: [] }] as unknown as Parameters<typeof attributeSessions>[1];
  const codex = all.map((session) => ({ ...session, provider: "codex" }));
  assert.deepEqual(attributeSessions(codex, accounts).byAccount.get("codex-aaaaaaaaaaaaaaaa")!.map(({ machine }) => machine), ["local"], "limits are read on this machine, so only its sessions are matched");
  assert.deepEqual(JSON.parse(JSON.stringify({ ...scope, sessions: [...scope.sessions!] })), { label: "laptop", others: ["agentbox"], sessions: ["local", "agentbox"] }, "a machine that was not read is not named");
  assert.equal(document.querySelector("#machine-strip-meta")!.textContent, "Subscription counts this machine only");
  // boxa's limits were read but its snapshot failed: it moves the meters, but none of its sessions are counted.
  const read = (key: string) => ({ key, label: key === "local" ? "laptop" : key, state: "ok", readAt: hoursAgo(0), durationMs: 1 });
  run(`limits = ${JSON.stringify({ schemaVersion: 2, dataSource: "live", accounts: [], observations: [], meters: [], sources: [], machines: ["local", "agentbox", "boxa"].map(read) })}; renderStripMeta()`);
  assert.equal(document.querySelector("#machine-strip-meta")!.textContent, "Subscription counts laptop + agentbox");
  run("switchView('summary')");
  assert.match(document.querySelector("#machine-strip-meta")!.textContent, /^snapshot \d\d:\d\d$/);
});

test("Read them again re-reads the machines without a full refresh, and a failed fetch keeps polling", async () => {
  const { context, document } = await rendered();
  const ticks: Array<() => void> = [], requests: string[] = [];
  let state = "reading", analytics = 0;
  context["setInterval"] = (callback: () => void) => { ticks.push(callback); return ticks.length; };
  context["clearInterval"] = () => {};
  context["fetch"] = async (url: string) => {
    requests.push(url);
    if (url === "/api/analytics?wait=10") {
      analytics += 1;
      // The first fetch of the new snapshot fails; polling carries on rather than leave the machine shown as reading.
      return analytics === 1 ? { ok: false, json: async () => ({}) } : { ok: true, json: async () => ({ ...context["fixture"] as object, machines: machines().map((machine) => ({ ...machine, state: "ok", reason: undefined, fix: undefined })) }) };
    }
    return { ok: true, json: async () => ({ machines: machines().map((machine) => machine.key === "boxa" ? { ...machine, state } : machine) }) };
  };
  const button = document.querySelector("#machines-read")!;
  assert.equal(button.hidden, false);
  button.listeners.get("click")!();
  for (let attempt = 0; attempt < 5; attempt++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests, ["/api/machines?read=1"]);
  assert.equal(button.disabled, true);
  state = "ok";
  ticks.at(-1)!();
  for (let attempt = 0; attempt < 5; attempt++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests.slice(1), ["/api/machines", "/api/analytics?wait=10"]);
  assert.equal(ticks.length, 2);
  ticks.at(-1)!();
  for (let attempt = 0; attempt < 5; attempt++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests.slice(3), ["/api/machines", "/api/analytics?wait=10"]);
  assert.equal(document.querySelector("#machines-read")!.hidden, true);
});
