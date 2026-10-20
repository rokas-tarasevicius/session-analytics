import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { compact, dateRange, dateTime, dayLabel, decimal, integer, money, moneyAxis, percent, timeLabel } from "../src/public/format.js";
import { money as pricingMoney, integer as pricingInteger } from "../src/public/pricing-data.js";
import { percent as summaryPercent, shortMoney } from "../src/public/view-model.js";

const { formatMetric } = await import(new URL("../src/public/velocity.js", import.meta.url).href);

test("shared money keeps ledger cents and rate precision while axes use compact dollars", () => {
  assert.equal(money(120.34), "$120.34");
  assert.equal(money(120), "$120.00");
  assert.equal(money(0), "$0.00");
  assert.equal(money(0.1234, 4), "$0.1234");
  assert.equal(formatMetric(0.000123, "value"), "$0.000123", "sub-cent activity retains its existing precision");
  assert.equal(moneyAxis(0.002), "$0.002", "sub-cent axes keep adaptive precision instead of $0.00");
  assert.equal(formatMetric(0.002, "value", true), "$0.002");
  for (const [value, expected] of [[0, "$0"], [7.5, "$7.50"], [9.994, "$9.99"], [9.996, "$10"], [10, "$10"], [120, "$120"], [999.6, "$1K"], [1900, "$1.9K"]] as const) {
    assert.equal(moneyAxis(value), expected);
    assert.equal(shortMoney(value), expected);
    assert.equal(formatMetric(value, "value", true), expected);
    assert.equal(formatMetric(value, "value"), money(value));
  }
  assert.equal(pricingMoney, money);
  assert.equal(pricingInteger, integer);
  assert.equal(summaryPercent, percent);
});

test("shared count and percentage formats retain grouping, compact counts and coverage precision", () => {
  assert.equal(integer(12345), "12,345");
  assert.equal(decimal(12345.67), "12,345.7");
  assert.equal(compact(12345), "12.3K");
  assert.equal(percent(0.125), "12.5%");
  assert.equal(percent(1), "100.0%");
  assert.equal(percent(1, 1, 0), "100%");
  assert.equal(percent(null), "N/A");
});

test("shared calendar labels and ranges use en-GB days without shifting snapshot calendar keys", () => {
  assert.equal(dayLabel("2026-09-13"), "13 Sept");
  assert.equal(dateRange("2026-09-13", "2026-10-12"), "13 Sept – 12 Oct 2026");
  assert.equal(dateRange("2026-12-31", "2027-01-01"), "31 Dec 2026 – 1 Jan 2027");
  assert.equal(dateRange("2026-09-13", "2026-09-13"), "13 Sept 2026");
  const script = `import { dayLabel, dateRange, dateTime } from ${JSON.stringify(new URL("../src/public/format.js", import.meta.url).href)}; console.log(JSON.stringify([dayLabel('2026-09-13'), dateRange('2026-09-13', '2026-10-12'), dateTime('2026-09-13T00:30:00Z', 'America/Los_Angeles')]));`;
  for (const TZ of ["UTC", "America/Los_Angeles", "Pacific/Kiritimati"]) {
    assert.deepEqual(JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, TZ }, encoding: "utf8" })),
      ["13 Sept", "13 Sept – 12 Oct 2026", "12 Sept 2026, 17:30"], TZ);
  }
});

test("shared date-times and stale clock labels use the snapshot timezone across DST and midnight", () => {
  assert.equal(dateTime("2026-09-13T23:30:00Z", "Europe/London"), "14 Sept 2026, 00:30");
  assert.equal(timeLabel("2026-09-13T23:30:00Z", "Europe/London"), "00:30");
  assert.equal(dateTime("2026-10-25T01:30:00Z", "Europe/London"), "25 Oct 2026, 01:30");
  assert.equal(dateTime("2026-09-13T23:30:00", "Europe/London"), "14 Sept 2026, 00:30", "offset-free provider timestamps retain their UTC meaning");
  assert.equal(dateTime(null), "Unknown time");
});


test("delta text uses shared arrows, precision and optional adjacent-period context", async () => {
  const { deltaText } = await import("../src/public/format.js");
  assert.equal(deltaText(0.132, 30), "▲ 13.2% vs previous 30d");
  assert.equal(deltaText(-0.12, 7), "▼ 12.0% vs previous 7d");
  assert.equal(deltaText(-0.0001, 7), "▬ 0.0% vs previous 7d");
  assert.equal(deltaText("new", 7), "new · vs previous 7d");
  assert.equal(deltaText(0.2), "▲ 20.0%");
});
