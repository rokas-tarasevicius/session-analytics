import assert from "node:assert/strict";
import test from "node:test";
import { ellipsize, reportTable, reportWidth, textWidth, wrapReport } from "../src/report/format.ts";

test("report width honors COLUMNS, terminal columns, then an 80-column pipe default", () => {
  assert.equal(reportWidth({ COLUMNS: "80" }, 120), 80);
  assert.equal(reportWidth({ COLUMNS: "120" }), 120);
  assert.equal(reportWidth({}, 100), 100);
  assert.equal(reportWidth({}), 80);
  for (const value of ["", "0", "19", "1001", "-80", "80.5", "Infinity", "1e2", "junk"]) {
    assert.equal(reportWidth({ COLUMNS: value }), 80, value);
    assert.equal(reportWidth({ COLUMNS: value }, 120), 120, value);
  }
  assert.equal(reportWidth({}, 0), 80);
});

test("report wrapping preserves evidence, blank lines and indentation", () => {
  const text = "Evidence: 30/489 summary-only, 48/489 activity-only; 24 file-modification dates (start unknown). Unavailable metrics are N/A.\n\n  Value: $881.51 · 74/83 sessions\n- A warning with several words that needs continuation indentation.\n";
  for (const width of [20, 80, 120]) {
    const result = wrapReport(text, width);
    assert.ok(result.split("\n").every((line) => textWidth(line) <= width));
    assert.equal(result.replace(/\s+/gu, " "), text.replace(/\s+/gu, " "));
    assert.match(result, /\n\n  Value:/);
    assert.ok(result.endsWith("\n"));
  }
  assert.equal(wrapReport("short  columns\n\n", 80), "short  columns\n\n");
  assert.equal(wrapReport("- warning words that wrap", 20), "- warning words that\n  wrap");
});

test("report wrapping splits long identifiers without dropping graphemes", () => {
  const text = "repository-".repeat(20);
  const result = wrapReport(text, 20);
  assert.equal(result.replaceAll("\n", ""), text);
  assert.ok(result.split("\n").every((line) => textWidth(line) <= 20));
  const unicode = "界e\u0301👩‍💻".repeat(20);
  const wrapped = wrapReport(unicode, 21);
  assert.equal(wrapped.replaceAll("\n", ""), unicode);
  assert.ok(wrapped.split("\n").every((line) => textWidth(line) <= 21));
  assert.doesNotMatch(wrapped, /\n[\p{Mark}\u200d]/u);
});

const headers = ["Repository", "Sessions", "Priced value", "Input tokens"];
const rows = [
  ["data-pipeline", "83", "$881.51 · 74/83 sessions", "303.9M · 75/83 sessions"],
  ["acme-web", "128", "$488.94 · 119/128 sessions", "505.4M · 120/128 sessions"],
];

test("wide repository tables align complete evidence cells beneath headers", () => {
  const result = reportTable(headers, rows, 120, [1, 2, 3]);
  const lines = result.trimEnd().split("\n");
  assert.equal(lines.length, 3);
  assert.ok(lines.every((line) => textWidth(line) <= 120));
  for (const row of rows) for (const value of row) assert.ok(result.includes(value));
  assert.equal(lines[1]!.indexOf("83") + 2, lines[2]!.indexOf("128") + 3);
});

test("narrow repository tables label each value instead of scrambling columns", () => {
  const result = reportTable(headers, rows, 60);
  assert.match(result, /data-pipeline\n  Sessions: 83\n  Priced value: \$881.51 · 74\/83 sessions\n  Input tokens: 303.9M · 75\/83 sessions\n\nacme-web/);
  for (const row of rows) for (const value of row) assert.ok(result.includes(value));
  assert.ok(result.split("\n").every((line) => textWidth(line) <= 60));
  const longName = [["a-very-long-repository-display-name", ...rows[0]!.slice(1)]];
  assert.match(reportTable(headers, longName, 80), /\n  Priced value:/);
  assert.equal(reportTable(headers, [], 80), "");
});

test("Unicode names align by terminal cells and long model lists show an ellipsis", () => {
  assert.equal(textWidth("界e\u0301👩‍💻🇬🇧"), 7);
  assert.equal(textWidth("©®™♥"), 4);
  assert.equal(textWidth("©️1️⃣\u{1b000}\u{17000}"), 8);
  assert.equal(textWidth("ꥠ𖿠"), 4);
  assert.equal(wrapReport("1️⃣".repeat(20), 20), `${"1️⃣".repeat(10)}\n${"1️⃣".repeat(10)}`);
  const result = reportTable(["Name", "Value"], [["界", "1"], ["e\u0301", "2"]], 80);
  assert.deepEqual(result.split("\n").slice(1).filter(Boolean).map((line) => textWidth(line.slice(0, -1))), [6, 6]);
  assert.equal(ellipsize("claude-opus-5, claude-sonnet-5", 20), "claude-opus-5, clau…");
  assert.equal(ellipsize("short", 20), "short");
  assert.equal(ellipsize("界e\u0301👩‍💻", 4), "界e\u0301…");
});
