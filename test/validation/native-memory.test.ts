import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("native memory: cold indexing validates forty thousand hourly usage cells within 128 MB", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "native-index-memory-"));
  try {
    const child = spawn(process.execPath, ["--max-old-space-size=128", new URL("../native-index-memory-worker.ts", import.meta.url).pathname, root], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = "";
    child.stdout.setEncoding("utf8").on("data", value => { output += value; });
    child.stderr.setEncoding("utf8").on("data", value => { errors += value; });
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    assert.equal(code, 0, errors);
    assert.deepEqual(JSON.parse(output), { sessions: 500, calls: 40_000, input: 4_000_000, output: 400_000 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native memory: fork fan-out retains only calls physically replayed in each child", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "native-fork-memory-"));
  try {
    const child = spawn(process.execPath, ["--max-old-space-size=128", new URL("../native-fork-memory-worker.ts", import.meta.url).pathname, root], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = "";
    child.stdout.setEncoding("utf8").on("data", value => { output += value; });
    child.stderr.setEncoding("utf8").on("data", value => { errors += value; });
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    assert.equal(code, 0, errors);
    assert.deepEqual(JSON.parse(output), { sessions: 601, calls: 10_600 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native memory: a thousand Claude children are discovered and billed once within the worker cap", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "native-claude-memory-"));
  try {
    const child = spawn(process.execPath, ["--max-old-space-size=128", new URL("../native-claude-memory-worker.ts", import.meta.url).pathname, root], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = "";
    child.stdout.setEncoding("utf8").on("data", value => { output += value; });
    child.stderr.setEncoding("utf8").on("data", value => { errors += value; });
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    assert.equal(code, 0, errors);
    assert.deepEqual(JSON.parse(output), { sessions: 1, files: 1_001, calls: 1_001 });
  } finally { await rm(root, { recursive: true, force: true }); }
});
