import assert from "node:assert/strict";
import test from "node:test";
import { analyzeOptionsFrom, remoteOptionsFrom } from "../src/options.ts";

test("analysis flags override environment settings without losing zero values", () => {
  const options = analyzeOptionsFrom(["--data-dir", "flag-data", "--time-zone", "UTC", "--pricing-max-age-days", "0"], {
    SESSION_ANALYTICS_DATA_DIR: "environment-data", SESSION_ANALYTICS_TIME_ZONE: "Europe/London", SESSION_ANALYTICS_PRICING_MAX_AGE_DAYS: "7",
  });
  assert.equal(options.dataDir, "flag-data");
  assert.equal(options.timeZone, "UTC");
  assert.equal(options.pricingMaxAgeDays, 0);
});

test("repeated remote flags add targets while explicit no-remote ignores the environment", () => {
  const options = remoteOptionsFrom(["--remote", "one,two", "--remote", "three", "--remote-timeout", "1"], { SESSION_ANALYTICS_REMOTE: "ignored", SESSION_ANALYTICS_REMOTE_TIMEOUT: "2" });
  assert.deepEqual(options.machines.map(({ ssh }) => ssh), ["one", "two", "three"]);
  assert.equal(options.timeoutMs, 1_000);
  assert.deepEqual(remoteOptionsFrom(["--no-remote"], { SESSION_ANALYTICS_REMOTE: "ignored" }).machines, []);
});
