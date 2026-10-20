#!/usr/bin/env node
/** Select only this repository's CI run for the release pull request. No API calls or approvals here. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function releaseCiRun(response: unknown, repository: string, pullRequest: number, sha: string): number | null {
  const runs = (response as { workflow_runs?: unknown[] } | null)?.workflow_runs;
  if (!Array.isArray(runs)) throw new Error("Expected a workflow run listing.");
  for (const value of runs) {
    if (!value || typeof value !== "object") continue;
    const run = value as Record<string, unknown>;
    const head = run["head_repository"] as { full_name?: unknown } | null;
    const requests = run["pull_requests"];
    if (run["event"] !== "pull_request" || run["path"] !== ".github/workflows/ci.yml" || run["head_sha"] !== sha ||
        run["head_branch"] !== "release/next" || head?.full_name !== repository || !Array.isArray(requests) ||
        !requests.some((request: unknown) => request && typeof request === "object" && (request as { number?: unknown }).number === pullRequest)) continue;
    const id = run["id"];
    if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) return id;
  }
  return null;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [repository, request, sha, ...rest] = process.argv.slice(2);
  if (!repository || !/^[^/]+\/[^/]+$/.test(repository) || !request || !/^\d+$/.test(request) || !Number.isSafeInteger(Number(request)) || Number(request) <= 0 || !sha || !/^[a-f0-9]{40}$/.test(sha) || rest.length) {
    throw new Error("Usage: node scripts/release-ci.ts OWNER/REPO PR HEAD_SHA < runs.json");
  }
  const run = releaseCiRun(JSON.parse(readFileSync(0, "utf8")), repository, Number(request), sha);
  if (run !== null) process.stdout.write(`${run}\n`);
}
