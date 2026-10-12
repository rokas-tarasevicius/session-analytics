// One money ledger everywhere: for any date window and repository focus, the Summary KPI, the fleet table, the
// repository bars, Costs (totals, providers and models), the Pricing cards, Velocity's usage value and the daily CSV
// export must show the same figures. These run the production renderers from app.js on one synthetic snapshot.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { emptySession } from "../src/providers/common.ts";
import type { ProviderEvidence, SessionAnalytics, SessionProvider } from "../src/types.ts";
import type { Element } from "./release-dom.ts";
import { harness } from "./validation/aggregation-ui-harness.ts";

const { csvTables, filterSnapshot } = await import(new URL("../src/public/export-data.js", import.meta.url).href);
const { pricingModelCards } = await import(new URL("../src/public/pricing-data.js", import.meta.url).href);
const { averagePrice, buildVelocity } = await import(new URL("../src/public/velocity-data.js", import.meta.url).href);

type Cell = [day: string, model: string, value: number, options?: { executionKind?: string; priced?: boolean }];
const repositories = [{ id: "alpha", name: "Alpha" }, { id: "beta", name: "Beta" }, { id: "gamma", name: "Gamma" }];

/** A session whose activity ledger holds `cells`; `sessionDated` cells have no request time of their own. */
function session(key: string, repository: string, provider: SessionProvider, costBasis: SessionAnalytics["costBasis"], createdAt: string,
  { cells = [], sessionDated = [], undated = 0, evidence, upper = 1 }: { cells?: Cell[]; sessionDated?: Cell[]; undated?: number; evidence?: ProviderEvidence; upper?: number }): SessionAnalytics {
  const name = repositories.find(({ id }) => id === repository)!.name;
  const s = emptySession({ id: key, path: "", cwd: null, createdAt, updatedAt: createdAt }, provider, { repository: { id: repository, name }, rateCard: { currency: "USD", effectiveDate: "2026-09-01", models: {} }, price: () => { throw Error("unused"); } }, evidence!);
  if (!evidence) delete s.evidence;
  const all = [...cells, ...sessionDated];
  const dimensions: Array<{ agent: string; model: string; executionKind: string; effort: string }> = [];
  const dimension = (model: string, executionKind = "top-level") => {
    let index = dimensions.findIndex((item) => item.model === model && item.executionKind === executionKind);
    if (index < 0) index = dimensions.push({ agent: provider === "codex" ? "codex-cli" : provider === "claude" ? "claude-cli" : provider, model, executionKind, effort: "unknown" }) - 1;
    return index;
  };
  const row = ([day, model, value, options = {}]: Cell) => [day, 10, dimension(model, options.executionKind), [value, 1000, 600, 400, 0, 200, 0, 2, 1, 0, options.priced === false ? 0 : 1200, 0, 1000, 0]];
  const total = all.reduce((sum, [, , value]) => sum + value, 0) + undated;
  s.costBasis = costBasis; s.cost.totalUsd = total; s.cost.upperEstimateUsd = total * upper;
  s.models = [...new Set(all.map(([, model]) => model))].filter((model) => model !== "<unknown>").map((model) => ({ model, calls: 2, priced: true, pricing: [], inputTokens: 1000, uncachedInputTokens: 600, cachedInputTokens: 400, cacheWriteInputTokens: 0, cacheWrite5mInputTokens: 0, cacheWrite1hInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0, nonReasoningOutputTokens: 200, cachedInputUsd: 0, cacheWriteUsd: 0, inputUsd: 0, outputUsd: 0, totalUsd: all.filter(([, m]) => m === model).reduce((sum, [, , value]) => sum + value, 0), upperEstimateUsd: 0 }));
  s.velocity = { dimensions, buckets: cells.map(row), undated: undated ? [[dimension("<unknown>"), [undated, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]]] : [], ...(sessionDated.length ? { sessionDated: sessionDated.map(row) } : {}) } as unknown as SessionAnalytics["velocity"];
  return s;
}

const receipt: ProviderEvidence = { source: "conductor-result", fidelity: "summary", tokens: "reported", tools: "unavailable", turns: "unavailable", timing: "provider", usageUnit: "run" };
const sdk: ProviderEvidence = { source: "cursor-sdk", fidelity: "summary", tokens: "reported", tools: "observed", turns: "observed", timing: "provider", usageUnit: "run" };
const gemini: ProviderEvidence = { source: "gemini-chat", fidelity: "message", tokens: "reported", tools: "observed", turns: "observed", timing: "provider", usageUnit: "request" };
const sessions = [
  // Started before every window; most of its value is on its first day.
  session("codex-early", "alpha", "codex", "api-list-price-equivalent", "2026-08-30T09:00:00Z", { cells: [["2026-08-30", "gpt-5.5", 50.17], ["2026-09-02", "gpt-5.5", 4.44], ["2026-10-02", "gpt-5.6-sol", 1.11]], upper: 1.25 }),
  session("claude-alpha", "alpha", "claude", "api-list-price-equivalent", "2026-09-01T08:00:00Z", { cells: [["2026-09-01", "claude-opus-5", 10.25], ["2026-09-15", "claude-sonnet-5", 3.1], ["2026-09-30", "claude-opus-5", 7.33], ["2026-09-30", "claude-sonnet-5", 2.07, { executionKind: "subagent" }]] }),
  // Provider-reported receipt: session-dated at its last activity, partly without model evidence.
  session("receipt-beta", "beta", "claude", "provider-reported", "2026-09-28T07:00:00Z", { evidence: receipt, sessionDated: [["2026-09-29", "claude-opus-5", 6.66], ["2026-09-29", "<unknown>", 1.01]] }),
  // Cursor's database value: provider-reported and undated, so in no window at all.
  session("cursor-db", "beta", "cursor", "provider-reported", "2026-09-29T07:00:00Z", { undated: 9.99 }),
  session("cursor-sdk", "gamma", "cursor", "api-list-price-equivalent", "2026-09-20T07:00:00Z", { evidence: sdk, cells: [["2026-09-20", "claude-opus-5", 2.5]], sessionDated: [["2026-09-21", "claude-opus-5", 0.75]] }),
  session("gemini-unpriced", "gamma", "gemini", "api-list-price-equivalent", "2026-09-25T07:00:00Z", { evidence: gemini, cells: [["2026-09-25", "gemini-3-pro", 0, { priced: false }]] }),
  // Started in the window, still running after its end.
  session("claude-gamma", "gamma", "claude", "api-list-price-equivalent", "2026-10-02T22:30:00Z", { cells: [["2026-10-02", "claude-opus-5", 3.03], ["2026-10-03", "claude-opus-5", 5.55]] }),
];

const cents = (text: string | null | undefined) => { const match = String(text ?? "").replace(/,/g, "").match(/\$(\d+(?:\.\d+)?)/); assert.ok(match, `no money in ${text}`); return Math.round(Number(match[1]) * 100); };
const round = (value: number) => Math.round(value * 100);
/** The value text of a ledger value holder (its badge, when present, is a sibling). */
const firstSpan = (cell: Element): Element => { const holder = cell.tagName === "span" || cell.tagName === "strong" ? cell : cell.children[0]!; return holder.children[0] ?? holder; };
/** Descendants of `#id` matching a simple selector (the test DOM matches only a selector's last compound). */
const within = (document: { querySelector: (selector: string) => Element | null }, id: string, selector: string) => document.querySelector(id)!.querySelectorAll(selector);

const windows = [
  { name: "the whole history", start: "2026-08-30", end: "2026-10-03" },
  { name: "a month starting after an earlier session began", start: "2026-09-01", end: "2026-10-01" },
  { name: "seven days with session-dated and provider-reported value", start: "2026-09-27", end: "2026-10-03" },
  { name: "one day inside a straddling session", start: "2026-10-02", end: "2026-10-02" },
  { name: "a quiet day", start: "2026-09-10", end: "2026-09-10" },
];

for (const window of windows) for (const focus of ["all", "beta"]) {
  test(`one ledger for ${window.name}${focus === "all" ? "" : ", focused on one repository"}: Summary, fleet table, Costs, Pricing, Velocity and daily CSV agree`, async () => {
    const { document, run, context } = await harness(sessions, { repositories, start: window.start, end: window.end, generatedAt: "2026-10-03T20:00:00Z", timeZone: "UTC" });
    run(`elements.repositoryFilter.value = ${JSON.stringify(focus)}; windowPreset = "custom"`);
    const scope = focus === "all" ? sessions : sessions.filter(({ repositoryId }) => repositoryId === focus);
    const expected = buildVelocity(scope, { start: window.start, end: window.end, group: "provider" }).totals[0];

    run("renderSummary(activeView())");
    const kpi = cents(document.querySelector("#metric-spend")!.textContent);
    assert.equal(kpi, round(expected), "Summary KPI is the ledger total");

    // Fleet table: expand quiet rows before reconciling; the focused fleet comparator is a separate total.
    document.querySelector("#repository-footer")!.querySelector("button")?.listeners.get("click")!();
    const header = within(document, "#repository-comparison", "th").findIndex((th) => th.querySelector("[data-sort=value]") !== null);
    const rows = within(document, "#repository-rows", "tr").filter((row) => row.dataset["rowLink"] === "true");
    const comparator = within(document, "#repository-rows", ".fleet-total")[0];
    if (focus !== "all") assert.equal(cents(comparator!.children[header]!.textContent), round(buildVelocity(sessions, { start: window.start, end: window.end }).totals[0]), "the comparator includes the whole fleet");
    assert.equal(rows.length, focus === "all" ? repositories.length : 1);
    assert.equal(rows.reduce((sum, row) => sum + cents(firstSpan(row.children[header]!)!.textContent), 0), kpi, "fleet rows add up to the KPI");
    const bars = within(document, "#repository-spend", ".bar-label").map((label) => label.children[1]!);
    assert.equal(bars.reduce((sum, bar) => sum + cents(bar.textContent), 0), kpi, "repository bars add up to the KPI");

    // Summary model mix: one "model · Provider" row each, adding up to the KPI.
    const mix = new Map(within(document, "#model-spend", ".bar-label").map((label) => [label.children[0]!.textContent.trim(), cents(label.children[1]!.textContent)]));
    assert.equal(new Set(mix.keys()).size, mix.size, "no duplicated model names");
    assert.equal([...mix.values()].reduce((sum, value) => sum + value, 0), kpi, "model mix adds up to the KPI");

    // Costs: the same total, its API/provider-reported split, provider rows and model rows.
    run("renderCosts(activeView())");
    assert.equal(cents(document.querySelector("#cost-total")!.textContent), kpi, "Costs total is the KPI");
    const api = cents(document.querySelector("#cost-api-total")!.textContent), reported = cents(document.querySelector("#cost-provider-total")!.textContent);
    assert.equal(api + reported, kpi, "API-equivalent + provider-reported = usage value");
    assert.match(document.querySelector("#cost-reconciliation")!.textContent, new RegExp(`\\$${(kpi / 100).toFixed(2)} usage value =`));
    const providerRows = within(document, "#provider-cost-models", ".cost-stack-row").filter((row) => !row.classList.contains("cost-stack-total"));
    const providerValues = providerRows.map((row) => cents(firstSpan(row.children.at(-1)!)!.textContent));
    assert.deepEqual(providerValues, [...providerValues].sort((a, b) => b - a), "provider bars run high to low");
    assert.equal(providerValues.reduce((sum, value) => sum + value, 0), kpi, "provider rows add up to the total");
    if (providerRows.length) assert.equal(cents(within(document, "#provider-cost-models", ".cost-stack-total")[0]!.textContent), kpi, "the total line is the KPI");
    const costModels = new Map(within(document, "#cost-models", ".cost-model-row").map((row) => [
      `${row.querySelector(".cost-model-label")!.children[0]!.textContent.trim()} · ${row.querySelector(".cost-model-label")!.children[1]!.textContent.trim()}`, cents(firstSpan(row.children[2]!)!.textContent)]));
    assert.equal([...costModels.values()].reduce((sum, value) => sum + value, 0), kpi, "Costs model rows add up to the total");

    // Per-model values: Summary's mix, Costs' rows and Velocity's model series are the same figures.
    const velocityModels = buildVelocity(scope, { start: window.start, end: window.end, group: "model", limit: 100 }).allSeries.filter(({ total }: { total: number }) => total > 0);
    for (const series of velocityModels as Array<{ label: string; total: number }>) {
      const label = series.label.replace(/^Unattributed model/, "No model evidence");
      assert.equal(costModels.get(label), round(series.total), `Costs ${label}`);
      if (mix.size <= 8) assert.equal(mix.get(series.label), round(series.total), `Summary mix ${series.label}`);
    }

    // Pricing: per provider and model; the cards add up to the API-equivalent part, the rest is provider-reported.
    const pricing = pricingModelCards({ models: [] }, scope, window);
    const cardIds = pricing.used.map(({ id }: { id: string }) => id);
    assert.equal(new Set(cardIds).size, cardIds.length, "one card per provider and model");
    assert.equal(round(pricing.used.reduce((sum: number, card: { usage: { valueUsd: number } }) => sum + card.usage.valueUsd, 0)), api, "Pricing cards add up to Costs' API-equivalent value");
    assert.equal(round(pricing.api + pricing.reported), kpi);
    for (const card of pricing.used as Array<{ id: string; usage: { valueUsd: number } }>) {
      const series = (velocityModels as Array<{ id: string; total: number }>).find(({ id }) => id === card.id);
      if (card.usage.valueUsd > 0) assert.ok(series, card.id);
    }
    assert.equal(document.querySelector("#cost-coverage")!.textContent, pricing.coverage === null ? "—" : `${(pricing.coverage * 100).toFixed(1)}%`, "Pricing and Costs report the same coverage");

    // Velocity's "Usage value" card with every provider chip on.
    assert.equal(round(averagePrice(buildVelocity(scope, { start: window.start, end: window.end, metric: "value", granularity: "day", mode: "lines" })).total), kpi, "Velocity usage value is the KPI");

    // Daily CSV from the export preview: the ledger cells of the window, including session-dated value.
    const source = await readFile(new URL("../src/public/app.js", import.meta.url), "utf8");
    run(source.slice(source.indexOf("function exportProviders("), source.indexOf("const resetExportMenu = installExportMenu")));
    context["velocityProviders"] = () => null;
    run("currentViewName = () => 'costs'");
    const selection = run("exportSelection()") as { snapshot: unknown; ledger: unknown; basis: string };
    const daily = csvTables(selection.snapshot, { ledger: selection.ledger })["daily.csv"].trim().split("\r\n").slice(1).map((line: string) => line.split(",").map((cell) => cell.replace(/^"|"$/g, "")));
    const csvTotal = daily.reduce((sum: number, row: string[]) => sum + Number(row[6]) + Number(row[7]), 0);
    assert.equal(round(csvTotal), kpi, "daily CSV adds up to the KPI");
    assert.equal(round(daily.reduce((sum: number, row: string[]) => sum + Number(row[7]), 0)), reported, "providerReportedSpendUsd is the provider-reported value");
    assert.ok(daily.every((row: string[]) => row[4]! >= window.start && row[4]! <= window.end), "only the window's dates");
    assert.match(selection.basis, new RegExp(`Daily value CSV: \\$${(kpi / 100).toFixed(2)} usage value by activity date, ${window.start} to ${window.end} \\(UTC\\)`));
    assert.equal(filterSnapshot.length >= 1, true);
  });
}

test("the export preview honours the active view's provider filters and stays available during a refresh", async () => {
  const { run, context } = await harness(sessions, { repositories, start: "2026-08-30", end: "2026-10-03", generatedAt: "2026-10-03T20:00:00Z", timeZone: "UTC" });
  const source = await readFile(new URL("../src/public/app.js", import.meta.url), "utf8");
  run(source.slice(source.indexOf("function exportProviders("), source.indexOf("const resetExportMenu = installExportMenu")));
  const exported = () => run("exportSelection()") as { snapshot: { sessions: SessionAnalytics[] }; ledger: { sessions: SessionAnalytics[] }; basis: string };
  const providers = (selection: ReturnType<typeof exported>) => [...new Set(selection.ledger.sessions.map(({ provider }) => provider))].sort();
  // Summary: the daily chart's provider chips.
  run("currentViewName = () => 'summary'; for (const input of providerFilters) input.checked = input.dataset.providerFilter === 'codex'");
  assert.deepEqual(providers(exported()), ["codex"]);
  assert.ok(exported().snapshot.sessions.every(({ provider }) => provider === "codex"));
  assert.match(exported().basis, /1 of 4 providers\./);
  // Velocity: its own chips.
  context["velocityProviders"] = () => ["claude", "cursor"];
  run("currentViewName = () => 'velocity'");
  assert.deepEqual(providers(exported()), ["claude", "cursor"]);
  // Costs and Pricing have no provider filter.
  run("currentViewName = () => 'costs'");
  assert.deepEqual(providers(exported()), ["claude", "codex", "cursor", "gemini"]);
  assert.doesNotMatch(exported().basis, /of 4 providers/);
  // A refresh keeps the current snapshot exportable.
  run("elements.sync.dataset.state = 'loading'");
  assert.ok(exported().snapshot);
});

test("daily CSV is the ledger: session-dated and provider-reported value are included, undated value never is", () => {
  const snapshot = { schemaVersion: 1, generatedAt: "2026-10-03T20:00:00Z", velocity: { version: 1, timeZone: "UTC" }, sessions, repositories: [] };
  const rows = csvTables(snapshot)["daily.csv"].trim().split("\r\n").slice(1).map((line: string) => line.split(",").map((cell) => cell.replace(/^"|"$/g, "")));
  const total = rows.reduce((sum: number, row: string[]) => sum + Number(row[6]) + Number(row[7]), 0);
  assert.equal(round(total), round(buildVelocity(sessions, { start: "2026-08-30", end: "2026-10-03" }).totals[0]));
  const receiptRow = rows.find((row: string[]) => row[1] === "beta" && row[4] === "2026-09-29")!;
  assert.deepEqual([receiptRow[3], receiptRow[5], receiptRow[6], receiptRow[7]], ["claude", "1", "0", "7.67"]);
  assert.ok(!rows.some((row: string[]) => row[3] === "cursor" && row[1] === "beta"), "Cursor database value has no date");
  assert.ok(rows.some((row: string[]) => row[3] === "cursor" && row[4] === "2026-09-21"), "Cursor SDK session-dated value is dated");
});
