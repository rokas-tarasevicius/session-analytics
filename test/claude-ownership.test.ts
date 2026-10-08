import assert from "node:assert/strict";
import test from "node:test";
import { readJsonLines } from "../src/jsonl-lines.ts";
import { buildClaudeUsageOwners } from "../src/providers/claude-ownership.ts";

const assistant = (id: string, output: number) => ({ type: "assistant", message: { id, usage: { input_tokens: 10, output_tokens: output } } });

async function owners(files: Record<string, unknown[]>, mains: Array<{ path: string; timestamp: string }>, unreadable = new Set<string>()) {
  return buildClaudeUsageOwners(mains,
    async (main) => Object.keys(files).filter((file) => file === main || file.startsWith(`${main.slice(0, -6)}/`)),
    async (path, visitor) => {
      for (const [line, record] of (files[path] ?? []).entries()) {
        if (unreadable.has(path) && line > 0) throw new Error("unreadable");
        visitor(record as never, line + 1);
      }
    });
}

test("sessions sharing a resumed message are marked, including through a sub-agent file", async () => {
  const result = await owners({
    "/a.jsonl": [assistant("shared", 10)],
    "/b.jsonl": [assistant("own-b", 5)],
    "/b/subagents/agent.jsonl": [assistant("shared", 20)],
    "/c.jsonl": [assistant("own-c", 5)],
  }, [{ path: "/a.jsonl", timestamp: "2026-07-20T12:00:00Z" }, { path: "/b.jsonl", timestamp: "2026-07-20T13:00:00Z" }, { path: "/c.jsonl", timestamp: "2026-07-20T14:00:00Z" }]);
  assert.equal(result.get("shared"), "/b.jsonl");
  assert.equal(result.sharedBy(["/a.jsonl"]), true);
  assert.equal(result.sharedBy(["/b.jsonl", "/b/subagents/agent.jsonl"]), true);
  assert.equal(result.sharedBy(["/c.jsonl"]), false);
});

test("a file the ownership pass did not read completely counts as shared only while any message is shared", async () => {
  const files = { "/a.jsonl": [assistant("shared", 10)], "/b.jsonl": [assistant("shared", 10)], "/c.jsonl": [assistant("x", 1), assistant("y", 1)] };
  const mains = [{ path: "/a.jsonl", timestamp: "2026-07-20T12:00:00Z" }, { path: "/b.jsonl", timestamp: "2026-07-20T13:00:00Z" }, { path: "/c.jsonl", timestamp: "2026-07-20T14:00:00Z" }];
  const partial = await owners(files, mains, new Set(["/c.jsonl"]));
  assert.equal(partial.sharedBy(["/c.jsonl"]), true);
  assert.equal(partial.sharedBy(["/never-visited.jsonl"]), true);
  const unshared = await owners({ "/c.jsonl": files["/c.jsonl"] }, [mains[2]!], new Set(["/c.jsonl"]));
  assert.equal(unshared.sharedBy(["/c.jsonl", "/never-visited.jsonl"]), false);
});

test("JSON Lines split identically across chunk boundaries", async () => {
  const lines = async (chunks: string[]) => { const out: string[] = []; for await (const line of readJsonLines((async function* () { yield* chunks; })())) out.push(line); return out; };
  assert.deepEqual(await lines(["a\nb", "\nc"]), ["a", "b", "c"]);
  assert.deepEqual(await lines(["", "a\n", "\n", "b"]), ["a", "", "b"]);
  assert.deepEqual(await lines(["a\r\n", "b\n"]), ["a\r", "b"]);
});
