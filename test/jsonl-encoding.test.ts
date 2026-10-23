import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeMachineSessions } from "../src/analyzer.ts";
import { readJsonLines } from "../src/jsonl-lines.ts";
import { jsonLines } from "../src/providers/common.ts";
import { validateSnapshot } from "../src/interop/snapshot.ts";
import { createProviderJsonlFixture } from "./fixtures.ts";
import { readCodexLedger } from "../src/store/codex-ledger.ts";
import { fingerprint } from "../src/store/fingerprint.ts";

async function collect<T>(input: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of input) values.push(value);
  return values;
}

async function lines(chunks: string[]): Promise<string[]> {
  return collect(readJsonLines((async function* () { yield* chunks; })()));
}

test("JSONL strips one BOM at stream start across chunk boundaries, preserving string contents", async () => {
  const raw = '﻿{"text":"雪﻿\u2028\u2029"}\r\n{"counter":2}';
  const expected = ['{"text":"雪﻿\u2028\u2029"}\r', '{"counter":2}'];
  for (let split = 0; split <= raw.length; split++) {
    assert.deepEqual(await lines(["", raw.slice(0, split), "", raw.slice(split)]), expected, `split ${split}`);
  }
  assert.deepEqual(await lines(["", "﻿", ""]), []);
  assert.deepEqual(await lines(["﻿", "﻿{}\n﻿{}"]), ["﻿{}", "﻿{}"], "only the first BOM is framing");
});

test("bounded JSONL handles BOM before the line budget and preserves malformed/oversized recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "jsonl-encoding-")), path = join(root, "records.jsonl");
  try {
    await writeFile(path, '﻿{"n":1}\r\n' + " ".repeat(70_000) + '\n﻿{"n":2}\n{"n":3}\n{"truncated":');
    assert.deepEqual(await collect(jsonLines(path, 8)), [{ n: 1 }, null, null, { n: 3 }, null]);
    for (const empty of ["", " \r\n\t", "﻿", "﻿ \r\n\t"]) {
      await writeFile(path, empty);
      assert.deepEqual(await collect(jsonLines(path)), []);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Codex append reads do not interpret a mid-file BOM as file framing", async () => {
  const root = await mkdtemp(join(tmpdir(), "ledger-encoding-")), path = join(root, "rollout.jsonl");
  const at = "2026-07-20T09:00:00.000Z", secret = Buffer.alloc(32, 1);
  const event = (input: number) => JSON.stringify({ type: "event_msg", timestamp: at, payload: {
    type: "token_count", info: { total_token_usage: { input_tokens: input }, last_token_usage: { input_tokens: 10 } },
  } });
  try {
    await writeFile(path, "﻿" + event(10) + "\n");
    const previous = await fingerprint(path, secret), first = await readCodexLedger(path, previous, secret);
    await appendFile(path, "﻿" + event(20) + "\n" + event(30) + "\n");
    const current = await fingerprint(path, secret);
    const resumed = await readCodexLedger(path, current, secret, { fingerprint: previous, evidence: first.evidence });
    const full = await readCodexLedger(path, current, secret);
    assert.equal(resumed.appended, true, "exercise the optimized append path");
    assert.equal(full.evidence.observations.length, 2, "mid-file BOM remains malformed");
    assert.deepEqual(resumed.evidence, full.evidence);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("BOM-prefixed provider histories retain plain JSONL accounting in full, cold and warm scans", async () => {
  const root = await mkdtemp(join(tmpdir(), "provider-encoding-"));
  try {
    const { options, paths } = await createProviderJsonlFixture(root);
    const plain = validateSnapshot(await analyzeMachineSessions(options));
    assert.equal(plain.sessions.length, 6);
    assert.equal(plain.sessions.find(s => s.provider === "claude")!.tokens.outputTokens, 40, "stream snapshots still dedupe");
    assert.equal(plain.sessions.find(s => s.evidence?.source === "cursor-sdk")!.metrics.toolCalls, 1);
    assert.equal(plain.sessions.find(s => s.evidence?.source === "cursor-transcript")!.metrics.userTurns, 1);
    // Seed an index before editing: a cached plain generation must not conceal a reader regression.
    assert.deepEqual((await analyzeMachineSessions({ ...options, noIndex: false })).sessions, plain.sessions);
    for (const path of paths) {
      const before = await stat(path);
      await writeFile(path, "﻿" + await readFile(path, "utf8"));
      await utimes(path, before.atime, before.mtime);
    }
    for (const noIndex of [true, false, false]) {
      const result = validateSnapshot(await analyzeMachineSessions({ ...options, noIndex }));
      assert.deepEqual(result.sessions, plain.sessions);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE-JSONL-ENCODING|encoding-response|encoding-agent|encoding-copilot|encoding-gemini|55555555-5555/);
    }
    const cold = { ...options, noIndex: false, dataDir: join(root, "cold-index") };
    assert.deepEqual((await analyzeMachineSessions(cold)).sessions, plain.sessions);
  } finally { await rm(root, { recursive: true, force: true }); }
});
