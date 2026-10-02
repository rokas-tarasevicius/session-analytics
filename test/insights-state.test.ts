import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Exercise the actual browser persistence module without adding DOM/runtime dependencies.
const source = await readFile(new URL("../src/public/views/insights-state.js", import.meta.url), "utf8");
const { readDecisions, saveDecision, storageKey, snoozeMilliseconds } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`) as {
  readDecisions: (storage: unknown, now?: number) => Record<string, string | number>;
  saveDecision: (storage: unknown, decisions: object, id: string, action: string, now?: number) => { decisions: Record<string, string | number>; persisted: boolean };
  storageKey: string; snoozeMilliseconds: number;
};

test("dismiss, snooze, expiry and restore persist only opaque IDs and survive corrupt/blocked storage", () => {
  let value = "{}";
  const storage = { getItem: (key: string) => { assert.equal(key, storageKey); return value; }, setItem: (_key: string, next: string) => { value = next; } };
  const id = "insight-1234567890abcdef1234";
  assert.equal(saveDecision(storage, {}, id, "dismiss").persisted, true);
  assert.equal(readDecisions(storage)[id], "dismissed");
  saveDecision(storage, {}, id, "snooze", 1000);
  assert.equal(readDecisions(storage, 1001)[id], 1000 + snoozeMilliseconds);
  assert.deepEqual(readDecisions(storage, 1000 + snoozeMilliseconds), {});
  saveDecision(storage, { [id]: "dismissed" }, id, "restore"); assert.deepEqual(readDecisions(storage), {});
  value = JSON.stringify({ "secret-path": "secret-message", [id]: "secret-content" }); assert.deepEqual(readDecisions(storage), {});
  value = "broken"; assert.deepEqual(readDecisions(storage), {});
  assert.deepEqual(readDecisions(null), {});
  assert.equal(saveDecision(null, {}, id, "dismiss").persisted, false);
  assert.deepEqual(saveDecision(storage, {}, "secret-key", "dismiss").decisions, {});
});
