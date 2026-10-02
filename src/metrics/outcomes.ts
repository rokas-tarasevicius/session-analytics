import { createHash } from "node:crypto";
import type { SessionDatabaseRow } from "../types.ts";
import type { OutcomeConfidence, OutcomeLink, OutcomeOperations, OutcomeSource, SessionOutcomes } from "./outcome-types.ts";
import type { OutcomeEnricher } from "./outcomes-enrichment.ts";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
const text = (value: unknown): string | null => typeof value === "string" && value.length > 0 && value.length <= 4096 ? value : null;
const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const hash = (kind: string, value: string): string => `${kind}-${createHash("sha256").update(`${kind}:${value}`).digest("hex").slice(0, 24)}`;
const sha = (value: unknown): string | null => typeof value === "string" && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(value) ? value.toLowerCase() : null;
const ranks: Record<OutcomeConfidence, number> = { weak: 0, medium: 1, strong: 2 };
const operations = (): OutcomeOperations => ({ commits: 0, pushes: 0, prsCreated: 0, prsEdited: 0, prsMerged: 0, prsClosed: 0 });

/** Private request target. This is never part of a session projection. */
export interface PullRequestTarget { repository: string; number: number }

export function pullRequestTarget(url: unknown, repository?: unknown, number?: unknown): PullRequestTarget | null {
  if (typeof url === "string") {
    try {
      const parsed = new URL(url);
      const match = /^\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)\/?$/.exec(parsed.pathname);
      if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash || !match) return null;
      repository = match[1]; number = Number(match[2]);
    } catch { return null; }
  }
  if (typeof repository !== "string" || repository.length > 201 ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository) ||
      typeof number !== "number" || !Number.isSafeInteger(number) || number < 1 || number > 2_147_483_647) return null;
  return { repository: repository.toLowerCase(), number };
}

/** Count only lines inside complete unified-diff hunks; filenames and text are discarded. */
export function countUnifiedDiff(value: unknown): { added: number; removed: number } | null {
  if (typeof value !== "string" || value.length > 8_000_000) return null;
  let oldRemaining = 0, newRemaining = 0, added = 0, removed = 0, hunks = 0;
  for (const line of value.split(/\r?\n/)) {
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      if (oldRemaining || newRemaining) return null;
      oldRemaining = Number(hunk[1] ?? 1); newRemaining = Number(hunk[2] ?? 1); hunks += 1;
    } else if (oldRemaining || newRemaining) {
      if (line.startsWith("+")) { newRemaining -= 1; added += 1; }
      else if (line.startsWith("-")) { oldRemaining -= 1; removed += 1; }
      else if (line.startsWith(" ")) { oldRemaining -= 1; newRemaining -= 1; }
      else if (!line.startsWith("\\ No newline at end of file")) return null;
      if (oldRemaining < 0 || newRemaining < 0) return null;
    } else if ((line.startsWith("+") && !line.startsWith("+++ ")) || (line.startsWith("-") && !line.startsWith("--- "))) {
      return null;
    }
  }
  return hunks && !oldRemaining && !newRemaining ? { added, removed } : null;
}

interface Lines { added: number; removed: number; measured: boolean; unmeasured: boolean; totalAdded: number | null; totalRemoved: number | null }

/** Accumulates allowlisted counters. Raw branches and PR targets are short-lived enrichment inputs only. */
export class OutcomeCollector {
  private row: SessionDatabaseRow;
  private links = new Map<string, OutcomeLink>();
  private seen = new Set<string>();
  private tools = new Map<string, string>();
  private streams = new Map<string, Lines>();
  private ops = operations();
  private editOperations = 0;
  private editsObserved = false;
  private lineSource: SessionOutcomes["lineSource"] = "unavailable";
  private truncated = false;
  private agentCommits = new Map<string, number>();
  private enrichment: SessionOutcomes["enrichment"] = { git: "off", github: "off" };
  readonly branches = new Set<string>();
  readonly pullRequests = new Map<string, PullRequestTarget>();
  private startingCommits = new Set<string>();
  private pendingPrs: Array<{ ref: string; number: number; event: string; action: string }> = [];

  constructor(row: SessionDatabaseRow) {
    this.row = row;
    this.branch(row.branch, "conductor-workspace");
    const archive = sha(row.outcome_archive_commit);
    if (archive) this.link("commit", hash("commit", `${row.repository_id}:${archive}`), "weak", "conductor-workspace", "context");
    if (row.outcome_pr_present === 1 && row.outcome_workspace_id) {
      const link = this.link("pull-request", hash("workspace-pr", row.outcome_workspace_id), "weak", "conductor-workspace", "context", "observation");
      if (link && (row.outcome_workspace_status === "merged" || row.outcome_workspace_status === "closed")) link.state = row.outcome_workspace_status;
    }
  }

  private unique(key: string): boolean {
    const digest = hash("event", key);
    if (this.seen.has(digest)) return false;
    if (this.seen.size >= 100_000) { this.truncated = true; return false; }
    this.seen.add(digest); return true;
  }

  private stream(key: string): Lines {
    let lines = this.streams.get(key);
    if (!lines) { lines = { added: 0, removed: 0, measured: false, unmeasured: false, totalAdded: null, totalRemoved: null }; this.streams.set(key, lines); }
    return lines;
  }

  private link(kind: OutcomeLink["kind"], ref: string, confidence: OutcomeConfidence, source: OutcomeSource,
    role: OutcomeLink["role"] = "outcome", identity: OutcomeLink["identity"] = "artifact"): OutcomeLink | null {
    // Context and produced evidence for the same commit have different meanings.
    const key = `${role}:${ref}`;
    let link = this.links.get(key);
    if (!link) {
      if (this.links.size >= 128) { this.truncated = true; return null; }
      link = { ref, kind, role, identity, confidence, sources: [], created: false, state: "unknown", timeToMergeMilliseconds: null };
      this.links.set(key, link);
    }
    if (ranks[confidence] > ranks[link.confidence]) link.confidence = confidence;
    if (!link.sources.includes(source)) link.sources.push(source);
    return link;
  }

  private branch(value: unknown, source: OutcomeSource, enrich = true): void {
    const branch = text(value);
    if (!branch) return;
    this.link("branch", hash("branch", `${this.row.repository_id}:${branch}`), "weak", source, "context");
    if (enrich) {
      if (this.branches.size < 8) this.branches.add(branch);
      else if (!this.branches.has(branch)) this.truncated = true;
    }
  }

  private pr(target: PullRequestTarget | null, event: string, source: OutcomeSource, action = ""): string | null {
    const ref = target ? hash("pr", `${target.repository}#${target.number}`) : hash("pr-event", `${this.row.conductor_session_id}:${event}`);
    const link = this.link("pull-request", ref, target ? "strong" : "medium", source, "outcome", target ? "artifact" : "observation");
    if (!link) return null;
    if (target) this.pullRequests.set(ref, target);
    if (action === "created") link.created = true;
    if (action === "merged") link.state = "merged";
    else if (action === "closed" && link.state !== "merged") link.state = "closed";
    else if (action === "created" && link.state === "unknown") link.state = "open";
    return ref;
  }

  private resolvePrs(): void {
    for (const pending of this.pendingPrs) {
      const matches = [...this.pullRequests.values()].filter((target) => target.number === pending.number);
      // A number alone is ambiguous across repositories. Only one locally
      // evidenced coordinate in this session may supply the missing identity.
      if (matches.length !== 1 || !matches[0]) continue;
      this.links.delete(`outcome:${pending.ref}`);
      this.pr(matches[0], pending.event, "claude-git-operation", pending.action);
    }
  }

  observeClaude(raw: RecordValue, stream = "main"): void {
    this.branch(raw["gitBranch"], "claude-branch", stream === "main");
    if (raw["type"] === "pr-link") {
      const target = pullRequestTarget(raw["prUrl"], raw["prRepository"], raw["prNumber"]);
      if (target) this.pr(target, "", "claude-pr-link");
    }
    if (raw["type"] === "cost-state") {
      const added = count(raw["totalLinesAdded"]), removed = count(raw["totalLinesRemoved"]);
      if (added !== null && removed !== null) {
        const lines = this.stream(stream);
        lines.totalAdded = Math.max(lines.totalAdded ?? 0, added);
        lines.totalRemoved = Math.max(lines.totalRemoved ?? 0, removed);
        this.editsObserved ||= added + removed > 0;
      }
    }
    const message = record(raw["message"]);
    const blocks = Array.isArray(message?.["content"]) ? message["content"].map(record) : [];
    if (raw["type"] === "assistant") {
      for (const block of blocks) {
        const id = text(block?.["id"]), name = text(block?.["name"]);
        if (block?.["type"] === "tool_use" && id && name && ["Edit", "Write", "MultiEdit"].includes(name)) {
          if (this.tools.size < 100_000) this.tools.set(`${stream}:${id}`, name);
          else this.truncated = true;
        }
      }
      return;
    }
    if (raw["type"] !== "user") return;
    const results = blocks.filter((block) => block?.["type"] === "tool_result");
    const result = results.length === 1 ? results[0] : null;
    const output = record(raw["toolUseResult"]);
    const id = text(result?.["tool_use_id"]) ?? text(raw["uuid"]);
    if (!result || !output || !id || result["is_error"] === true || output["interrupted"] === true ||
        (count(output["timedOutAfterMs"]) ?? 0) > 0 || !this.unique(`claude:${stream}:${id}`)) return;
    const event = `${stream}:${id}`;
    const op = record(output["gitOperation"]);
    const commit = record(op?.["commit"]);
    if (commit && (commit["kind"] === undefined || ["committed", "amended"].includes(String(commit["kind"])))) {
      this.ops.commits += 1;
      const commitSha = sha(commit["sha"]);
      this.link("commit", commitSha ? hash("commit", `${this.row.repository_id}:${commitSha}`) : hash("commit-event", `${this.row.conductor_session_id}:${event}`),
        "strong", "claude-git-operation", "outcome", commitSha ? "artifact" : "observation");
      this.branch(commit["branch"], "claude-git-operation", stream === "main");
    }
    const push = record(op?.["push"]);
    if (push) { this.ops.pushes += 1; this.branch(push["branch"], "claude-git-operation", stream === "main"); }
    const pr = record(op?.["pr"]);
    const action = text(pr?.["action"]);
    if (pr && action && ["created", "edited", "merged", "closed"].includes(action)) {
      const key = { created: "prsCreated", edited: "prsEdited", merged: "prsMerged", closed: "prsClosed" }[action] as keyof OutcomeOperations;
      this.ops[key] += 1;
      const target = pullRequestTarget(pr["url"], pr["repository"], pr["number"]);
      const ref = this.pr(target, `${event}:${action}`, "claude-git-operation", action);
      const number = count(pr["number"]);
      if (ref && !target && pr["url"] === undefined && number !== null && number > 0 && number <= 2_147_483_647) {
        this.pendingPrs.push({ ref, number, event: `${event}:${action}`, action });
      }
    }
    const patch = output["structuredPatch"];
    const edit = Array.isArray(patch) || this.tools.has(event);
    if (edit) {
      this.editsObserved = true; this.editOperations += 1;
    }
    if (Array.isArray(patch) && patch.length > 0) {
      let added = 0, removed = 0, valid = true;
      for (const rawHunk of patch) {
        const hunk = record(rawHunk), lines = hunk?.["lines"];
        if (!Array.isArray(lines) || !lines.every((line) => typeof line === "string")) { valid = false; break; }
        for (const line of lines as string[]) { added += Number(line.startsWith("+")); removed += Number(line.startsWith("-")); }
      }
      if (valid) {
        const lines = this.stream(stream); lines.added += added; lines.removed += removed; lines.measured = true;
      } else this.stream(stream).unmeasured = true;
    } else if (edit) this.stream(stream).unmeasured = true;
  }

  observeCodex(raw: RecordValue, line: number): void {
    const payload = record(raw["payload"]);
    if (raw["type"] === "session_meta") {
      const git = record(payload?.["git"]);
      this.branch(git?.["branch"], "codex-session-git");
      const commit = sha(git?.["commit_hash"]);
      if (commit) {
        if (this.startingCommits.size < 128) this.startingCommits.add(commit);
        else this.truncated = true;
        this.link("commit", hash("commit", `${this.row.repository_id}:${commit}`), "weak", "codex-session-git", "context");
      }
    }
    if (raw["type"] !== "event_msg" || payload?.["type"] !== "item_completed") return;
    const item = record(payload["item"]);
    if (item?.["type"] !== "FileChange" || (item["status"] !== undefined && !["completed", "success", "succeeded"].includes(String(item["status"])))) return;
    const id = text(item["id"]) ?? `line:${line}`;
    if (!this.unique(`codex:${id}`)) return;
    this.editsObserved = true; this.editOperations += 1;
    const changes = record(item["changes"]);
    if (!changes || Object.keys(changes).length === 0) { this.stream("main").unmeasured = true; return; }
    let added = 0, removed = 0;
    for (const change of Object.values(changes)) {
      const diff = countUnifiedDiff(record(change)?.["unified_diff"]);
      if (!diff) { this.stream("main").unmeasured = true; return; } // Never turn an incomplete event into measured zero.
      added += diff.added; removed += diff.removed;
    }
    const lines = this.stream("main"); lines.added += added; lines.removed += removed; lines.measured = true;
    this.lineSource = "codex-file-change";
  }

  observeCursor(raw: RecordValue): void {
    const added = count(raw["totalLinesAdded"]), removed = count(raw["totalLinesRemoved"]);
    if (added === null || removed === null) return;
    const lines = this.stream("main"); lines.totalAdded = added; lines.totalRemoved = removed;
    this.editsObserved = added + removed > 0; this.lineSource = "cursor-composer";
  }

  addGitCommit(commit: string, agentCoauthorTrailers: number): void {
    const value = sha(commit);
    if (!value) return;
    const ref = hash("commit", `${this.row.repository_id}:${value}`);
    this.link("commit", ref, "medium", "local-git");
    if (agentCoauthorTrailers > 0) this.agentCommits.set(ref, Math.max(this.agentCommits.get(ref) ?? 0, agentCoauthorTrailers));
  }

  isStartingCommit(commit: string): boolean { return this.startingCommits.has(commit.toLowerCase()); }

  addGithubState(ref: string, state: "open" | "closed" | "merged", timeToMergeMilliseconds: number | null): void {
    const link = this.links.get(`outcome:${ref}`);
    if (!link) return;
    if (!link.sources.includes("github")) link.sources.push("github");
    link.state = state; link.timeToMergeMilliseconds = timeToMergeMilliseconds;
  }

  async finish(enricher: OutcomeEnricher, start: string | null, end: string | null): Promise<SessionOutcomes> {
    this.resolvePrs();
    this.enrichment = await enricher.enrich(this, this.row, start, end);
    return this.project();
  }

  project(): SessionOutcomes {
    this.resolvePrs();
    let added = 0, removed = 0, measured = false, partial = false;
    const sources = new Set<SessionOutcomes["lineSource"]>();
    const main = this.streams.get("main");
    // Top-level cost-state is the provider's composite session total. Do not add
    // the same sub-agent edits or structured patches to that cumulative counter.
    const streams = main?.totalAdded !== null && main?.totalAdded !== undefined ? [main] : [...this.streams.values()];
    for (const lines of streams) {
      if (lines.totalAdded !== null && lines.totalRemoved !== null) {
        added += lines.totalAdded; removed += lines.totalRemoved; measured = true;
        sources.add(this.lineSource === "cursor-composer" ? "cursor-composer" : "claude-cost-state");
      } else if (lines.measured) {
        added += lines.added; removed += lines.removed; measured = true;
        sources.add(this.lineSource === "codex-file-change" ? "codex-file-change" : "claude-structured-patch");
      }
      if (lines.totalAdded === null && lines.unmeasured) partial = true;
    }
    return {
      editsObserved: this.editsObserved, editOperations: this.editOperations,
      linesAdded: measured ? added : null, linesRemoved: measured ? removed : null,
      lineCoverage: !measured ? "unavailable" : partial ? "partial" : "complete",
      lineSource: sources.size > 1 ? "mixed" : [...sources][0] ?? "unavailable",
      operations: { ...this.ops },
      links: [...this.links.values()].map((link) => ({ ref: link.ref, kind: link.kind, role: link.role,
        identity: link.identity, confidence: link.confidence, sources: [...link.sources].sort(),
        created: link.created, state: link.state, timeToMergeMilliseconds: link.timeToMergeMilliseconds,
      })).sort((a, b) => a.ref.localeCompare(b.ref) || a.role.localeCompare(b.role)),
      agentCoauthoredCommits: this.agentCommits.size,
      agentCoauthorTrailers: [...this.agentCommits.values()].reduce((sum, value) => sum + value, 0),
      enrichment: { ...this.enrichment }, truncated: this.truncated,
    };
  }
}
