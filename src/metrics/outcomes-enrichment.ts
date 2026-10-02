import { execFile } from "node:child_process";
import { resolve } from "node:path";
import type { AnalyzeOptions, SessionDatabaseRow } from "../types.ts";
import type { OutcomeEnrichmentStatus, SessionOutcomes } from "./outcome-types.ts";
import type { OutcomeCollector } from "./outcomes.ts";

export type OutcomeCommand = (command: "git" | "gh", args: string[], timeout: number) => Promise<string | null>;

const run: OutcomeCommand = (command, args, timeout) => new Promise((resolve) => {
  // Never use a shell, prompt, fetch a Git remote, or expose stderr. The inherited
  // environment supplies gh authentication, but cannot redirect it to another host.
  const environment: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GH_HOST: "github.com" };
  delete environment["GH_DEBUG"];
  if (command === "git") {
    for (const key of Object.keys(environment)) {
      if (["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_SHALLOW_FILE", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"].includes(key) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete environment[key];
    }
  }
  execFile(command, args, { encoding: "utf8", timeout, maxBuffer: 512 * 1024, env: environment, windowsHide: true },
    (error, stdout) => resolve(error ? null : stdout));
});

function branchRef(branch: string): string | null {
  // Fully qualify the evidenced local branch; never accept options, revisions,
  // ref expressions, remotes, or an implicit current checkout as its substitute.
  const name = branch.startsWith("refs/heads/") ? branch.slice(11) : branch;
  if (!name || name.length > 240 || /[\s\x00-\x1f\x7f~^:?*\[\\]/.test(name) ||
      name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".") ||
      name.includes("..") || name.includes("@{") || name.includes("//") ||
      name.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))) return null;
  return `refs/heads/${name}`;
}

interface GithubState { state: "open" | "closed" | "merged"; timeToMergeMilliseconds: number | null }

/** Per-analysis budget and cache: a refresh creates a new instance. Both modes default off. */
export class OutcomeEnricher {
  private options: AnalyzeOptions;
  private command: OutcomeCommand;
  private started: number | null = null;
  private gitQueries = 0;
  private githubQueries = 0;
  private github = new Map<string, GithubState | null>();
  private githubAuthenticated: boolean | null = null;

  constructor(options: AnalyzeOptions = {}, command: OutcomeCommand = run) {
    this.options = options; this.command = command;
  }

  private remaining(): number {
    this.started ??= Date.now();
    return Math.max(0, 30_000 - (Date.now() - this.started));
  }

  private async git(collector: OutcomeCollector, row: SessionDatabaseRow, start: string | null, end: string | null): Promise<OutcomeEnrichmentStatus> {
    if (!this.options.outcomesGit) return "off";
    const from = Date.parse(start ?? ""), through = Date.parse(end ?? "");
    if (!row.root_path || !Number.isFinite(from) || !Number.isFinite(through) || through < from || through - from > 7 * 86_400_000 || !collector.branches.size) return "not-applicable";
    let matched = false, unavailable = false, queried = false;
    for (const branch of collector.branches) {
      const ref = branchRef(branch);
      if (!ref) continue;
      if (this.gitQueries >= 100 || this.remaining() < 100) return "limited";
      this.gitQueries += 1; queried = true;
      const output = await this.command("git", ["--no-pager", "-C", row.root_path,
        "-c", "core.fsmonitor=false", "-c", "log.showSignature=false", "--no-replace-objects",
        "log", "--no-show-signature", "--no-decorate", "--max-count=201",
        `--since=${new Date(from - 1000).toISOString()}`, `--until=${new Date(through + 1000).toISOString()}`,
        "--format=%H%x00%ct%x00%(trailers:key=Co-authored-by,valueonly,separator=%x1f)%x1e", ref, "--"], Math.min(3000, this.remaining()));
      if (output === null) { unavailable = true; continue; }
      const entries = output.split("\x1e").map((entry) => entry.trim()).filter(Boolean);
      // A capped history is incomplete: retain the bounded observations and label it.
      for (const entry of entries.slice(0, 200)) {
        const [commit, seconds, trailers] = entry.split("\0");
        const timestamp = Number(seconds) * 1000;
        if (!commit || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(commit) || !seconds || !/^\d+$/.test(seconds ?? "") ||
            !Number.isFinite(timestamp) || timestamp < from || timestamp > through || collector.isStartingCommit(commit)) continue;
        const agentTrailers = (trailers ?? "").split("\x1f").filter((trailer) => /^(?:claude|codex|cursor)(?:\s|<|$)/i.test(trailer.trim())).length;
        collector.addGitCommit(commit, agentTrailers); matched = true;
      }
      if (entries.length > 200) return "limited";
    }
    return unavailable ? "unavailable" : matched ? "matched" : queried ? "no-match" : "not-applicable";
  }

  private async githubState(collector: OutcomeCollector): Promise<OutcomeEnrichmentStatus> {
    if (!this.options.outcomesGithub) return "off";
    if (!collector.pullRequests.size) return "not-applicable";
    if (this.githubAuthenticated === null) {
      if (this.remaining() < 100) return "limited";
      this.githubAuthenticated = await this.command("gh", ["auth", "status", "--hostname", "github.com"], Math.min(4000, this.remaining())) !== null;
    }
    if (!this.githubAuthenticated) return "unavailable";
    let unavailable = false;
    for (const [ref, target] of collector.pullRequests) {
      if (!this.github.has(ref)) {
        if (this.githubQueries >= 20 || this.remaining() < 100) return "limited";
        this.githubQueries += 1;
        const response = await this.command("gh", ["pr", "view", String(target.number), "--repo", `https://github.com/${target.repository}`,
          "--json", "state,createdAt,mergedAt"], Math.min(4000, this.remaining()));
        let state: GithubState | null = null;
        if (response !== null) {
          try {
            const raw = JSON.parse(response) as Record<string, unknown>;
            if (raw && ["OPEN", "CLOSED", "MERGED"].includes(String(raw["state"]))) {
              const created = typeof raw["createdAt"] === "string" ? Date.parse(raw["createdAt"]) : NaN;
              const merged = typeof raw["mergedAt"] === "string" ? Date.parse(raw["mergedAt"]) : NaN;
              state = { state: String(raw["state"]).toLowerCase() as GithubState["state"],
                timeToMergeMilliseconds: raw["state"] === "MERGED" && Number.isFinite(created) && Number.isFinite(merged) && merged >= created ? merged - created : null };
            }
          } catch { /* A malformed response is a fixed unavailable status, never a raw error. */ }
        }
        this.github.set(ref, state);
      }
      const state = this.github.get(ref);
      if (!state) unavailable = true;
      else collector.addGithubState(ref, state.state, state.timeToMergeMilliseconds);
    }
    return unavailable ? "unavailable" : "matched";
  }

  async enrich(collector: OutcomeCollector, row: SessionDatabaseRow, start: string | null, end: string | null): Promise<SessionOutcomes["enrichment"]> {
    const remote = (value: string) => value.trim().replace(/^git@([^:]+):/, "https://$1/").replace(/\.git$/, "").replace(/\/$/, "").toLowerCase();
    if ((this.options.repositoryId && row.repository_id !== this.options.repositoryId) ||
        (this.options.repositoryName && row.repository_name !== this.options.repositoryName) ||
        (this.options.repositoryRoot && resolve(row.root_path) !== resolve(this.options.repositoryRoot)) ||
        (this.options.repositoryRemote && remote(row.repository_remote) !== remote(this.options.repositoryRemote))) {
      return { git: this.options.outcomesGit ? "not-applicable" : "off", github: this.options.outcomesGithub ? "not-applicable" : "off" };
    }
    const git = await this.git(collector, row, start, end);
    const github = await this.githubState(collector);
    return { git, github };
  }
}
