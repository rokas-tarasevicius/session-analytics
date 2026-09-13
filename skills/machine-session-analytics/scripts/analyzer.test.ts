import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { analyzeMachineSessions, analyzeRepositorySessions } from "./analyzer.ts";
import { createSessionAnalyticsFixture } from "./test-support.ts";

test("analyzes Codex, Claude, and Cursor sessions without returning transcript content", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "machine-session-analytics-"));
  try {
    const fixture = await createSessionAnalyticsFixture(temporaryDirectory);
    const result = await analyzeRepositorySessions({
      claudeRoot: fixture.claudeRoot,
      codexArchiveRoot: fixture.codexArchiveRoot,
      codexRoot: fixture.codexRoot,
      cursorDatabasePath: fixture.cursorDatabasePath,
      databasePath: fixture.databasePath,
      repositoryRemote: fixture.remote,
      repositoryRoot: fixture.repositoryRoot,
    });

    assert.equal(result.repository.name, "conductor");
    assert.equal(result.summary.sessions, 5);
    assert.equal(result.summary.analyzedSessions, 5);
    assert.equal(result.summary.missingTranscripts, 0);
    assert.equal(result.summary.pricedTokenCoverage, 1);
    assert.equal(result.summary.providerReportedSpendUsd, 1.48);
    assert.equal(result.summary.subagentSessions, 2);
    assert.equal(result.summary.topLevelSessions, 5);

    const codex = result.sessions.find(({ provider }) => provider === "codex");
    assert.ok(codex);
    assert.deepEqual(codex.tokens, {
      cacheWrite1hInputTokens: 0,
      cacheWrite5mInputTokens: 0,
      cacheWriteInputTokens: 0,
      cachedInputTokens: 1200,
      inputTokens: 1500,
      nonReasoningOutputTokens: 100,
      outputTokens: 150,
      reasoningOutputTokens: 50,
      uncachedInputTokens: 300,
    });
    assert.equal(codex.cost.totalUsd, 0.00468);
    assert.equal(Number(codex.cost.upperEstimateUsd.toFixed(8)), 0.00498);
    assert.deepEqual(codex.tools, { apply_patch: 1, exec_command: 1 });
    assert.deepEqual(codex.skills, { "frontend-design": 1 });
    assert.equal(codex.skillEvidence, "inferred");
    assert.equal(codex.metrics.taskCompletions, 1);
    assert.equal(codex.metrics.compactions, 1);
    assert.equal(codex.metrics.contextUtilizationPeak, 0.5);
    assert.equal(codex.executionKind, "top-level");
    assert.equal(codex.costBasis, "api-list-price-equivalent");
    const archivedSubagent = result.sessions.find(
      ({ executionKind, provider }) => provider === "codex" && executionKind === "mixed",
    );
    assert.ok(archivedSubagent);
    assert.equal(archivedSubagent.provider, "codex");
    assert.equal(archivedSubagent.tokens.inputTokens, 100);
    assert.equal(archivedSubagent.costByExecution.subagentUsd, 0);
    assert.ok(archivedSubagent.costByExecution.topLevelUsd > 0);
    assert.equal(
      archivedSubagent.transcript.warnings.some((warning) => warning.includes("process-wide token snapshot")),
      true,
    );

    const claude = result.sessions.find(({ provider }) => provider === "claude");
    assert.ok(claude);
    assert.deepEqual(claude.tokens, {
      cacheWrite1hInputTokens: 50,
      cacheWrite5mInputTokens: 150,
      cacheWriteInputTokens: 200,
      cachedInputTokens: 400,
      inputTokens: 750,
      nonReasoningOutputTokens: 50,
      outputTokens: 50,
      reasoningOutputTokens: 0,
      uncachedInputTokens: 150,
    });
    assert.equal(claude.cost.totalUsd, 0.0036375);
    assert.deepEqual(
      claude.models.map(({ model, priced }) => ({ model, priced })),
      [{ model: "claude-opus-5", priced: true }],
    );
    assert.deepEqual(claude.tools, { Bash: 1, Read: 1, Skill: 1 });
    assert.deepEqual(claude.skills, { review: 1 });
    assert.equal(claude.skillEvidence, "explicit");
    assert.equal(claude.metrics.assistantMessages, 2);
    assert.equal(claude.metrics.userTurns, 1);
    assert.equal(claude.metrics.delegatedAgents, 1);
    assert.equal(claude.transcript.files, 2);
    assert.equal(claude.executionKind, "mixed");
    assert.equal(claude.costByExecution.subagentUsd, 0.00055);
    assert.equal(claude.costByExecution.topLevelUsd, 0.0030875);

    const cursor = result.sessions.find(({ models }) => models.some(({ model }) => model === "cursor-fixture-model"));
    assert.ok(cursor);
    assert.equal(cursor.tokens.inputTokens, 200);
    assert.equal(cursor.tokens.outputTokens, 40);
    assert.equal(cursor.pricedTokenCoverage, null);
    assert.equal(cursor.cost.totalUsd, 1.23);
    assert.equal(cursor.costBasis, "provider-reported");
    assert.deepEqual(cursor.tools, { edit_file: 1 });
    assert.deepEqual(cursor.skills, {});
    assert.equal(cursor.skillEvidence, "unavailable");
    const metadataOnlyCursor = result.sessions.find(({ models }) => models.some(({ model }) => model === "cursor-archived-model"));
    assert.ok(metadataOnlyCursor);
    assert.equal(metadataOnlyCursor.cost.totalUsd, 0.25);
    assert.deepEqual(metadataOnlyCursor.spendByDay, {});
    assert.equal(metadataOnlyCursor.metrics.modelCalls, 1);
    assert.equal(metadataOnlyCursor.tokens.inputTokens, 300);
    assert.equal(metadataOnlyCursor.firstEventAt, "2026-07-19T14:00:00.000Z");
    assert.deepEqual(metadataOnlyCursor.tools, { search_code: 1 });

    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /secret-command|secret-path|secret-skill-args|content-is-not-returned/);
    assert.doesNotMatch(serialized, /rollout-|transcriptPath|Codex fixture session|codex-fixture/);
    assert.doesNotMatch(serialized, /Codex fixture|Claude fixture|example\/conductor\.git/);
    assert.doesNotMatch(serialized, /11111111-1111-4111-8111-111111111111/);
    assert.doesNotMatch(serialized, /22222222-2222-4222-8222-222222222222/);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("scans every visible Conductor repository and preserves zero-session repositories", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "conductor-machine-analytics-"));
  try {
    const fixture = await createSessionAnalyticsFixture(temporaryDirectory);
    const result = await analyzeMachineSessions({
      claudeRoot: fixture.claudeRoot,
      codexArchiveRoot: fixture.codexArchiveRoot,
      codexRoot: fixture.codexRoot,
      cursorDatabasePath: fixture.cursorDatabasePath,
      databasePath: fixture.databasePath,
    });

    assert.equal(result.summary.repositories, 3);
    assert.equal(result.summary.repositoriesWithSessions, 1);
    assert.equal(result.summary.sessions, 5);
    assert.deepEqual(
      result.repositories.map(({ repository }) => repository.name),
      ["conductor", "hidden-repository", "quiet-repository"],
    );
    assert.equal(result.repositories[1]?.summary.sessions, 0);
    assert.equal(result.sessions.every(({ repositoryName }) => repositoryName === "conductor"), true);

    const sessionInput = result.sessions.reduce((total, session) => total + session.tokens.inputTokens, 0);
    const sessionOutput = result.sessions.reduce((total, session) => total + session.tokens.outputTokens, 0);
    const sessionValue = result.sessions.reduce((total, session) => total + session.cost.totalUsd, 0);
    assert.equal(result.summary.totalInputTokens, sessionInput);
    assert.equal(result.summary.outputTokens, sessionOutput);
    assert.equal(result.summary.estimatedSpendUsd, sessionValue);
    for (const session of result.sessions) {
      assert.equal(
        session.cost.totalUsd,
        session.models.reduce((total, model) => total + model.totalUsd, 0),
      );
      assert.equal(
        session.cost.totalUsd,
        session.costByExecution.subagentUsd +
          session.costByExecution.topLevelUsd +
          session.costByExecution.unknownUsd,
      );
      if (session.provider !== "cursor") {
        assert.equal(
          session.tokens.inputTokens,
          session.models.reduce((total, model) => total + model.inputTokens, 0),
        );
        assert.equal(
          session.tokens.outputTokens,
          session.models.reduce((total, model) => total + model.outputTokens, 0),
        );
        assert.equal(
          session.cost.totalUsd,
          Object.values(session.spendByDay).reduce((total, value) => total + value, 0),
        );
      }
    }

    const withoutHidden = await analyzeMachineSessions({
      claudeRoot: fixture.claudeRoot,
      codexArchiveRoot: fixture.codexArchiveRoot,
      codexRoot: fixture.codexRoot,
      cursorDatabasePath: fixture.cursorDatabasePath,
      databasePath: fixture.databasePath,
      includeHidden: false,
    });
    assert.equal(withoutHidden.summary.repositories, 2);
    assert.equal(withoutHidden.repositories.at(-1)?.repository.name, "quiet-repository");
    assert.equal(withoutHidden.repositories.some(({ repository }) => repository.name === "hidden-repository"), false);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("retains end-to-end pricing for Claude Opus 4.8", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "machine-session-opus-4-8-"));
  try {
    const fixture = await createSessionAnalyticsFixture(temporaryDirectory, "claude-opus-4-8");
    const result = await analyzeRepositorySessions({
      claudeRoot: fixture.claudeRoot,
      codexArchiveRoot: fixture.codexArchiveRoot,
      codexRoot: fixture.codexRoot,
      cursorDatabasePath: fixture.cursorDatabasePath,
      databasePath: fixture.databasePath,
      repositoryRemote: fixture.remote,
      repositoryRoot: fixture.repositoryRoot,
    });
    const claude = result.sessions.find(({ provider }) => provider === "claude");
    assert.ok(claude);
    assert.deepEqual(
      claude.models.map(({ model, priced }) => ({ model, priced })),
      [{ model: "claude-opus-4-8", priced: true }],
    );
    assert.equal(claude.cost.totalUsd, 0.0036375);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("keeps unknown provider models unpriced instead of applying a database-model fallback", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "conductor-session-unpriced-"));
  try {
    const fixture = await createSessionAnalyticsFixture(temporaryDirectory);
    const codexDay = join(fixture.codexRoot, "2026/07/20");
    const [filename] = await readdir(codexDay);
    assert.ok(filename);
    const transcript = join(codexDay, filename);
    const evidence = await readFile(transcript, "utf8");
    await writeFile(transcript, evidence.replaceAll("gpt-5.6-sol", "unknown-test-model"));

    const result = await analyzeRepositorySessions({
      claudeRoot: fixture.claudeRoot,
      codexArchiveRoot: fixture.codexArchiveRoot,
      codexRoot: fixture.codexRoot,
      cursorDatabasePath: fixture.cursorDatabasePath,
      databasePath: fixture.databasePath,
      repositoryRemote: fixture.remote,
      repositoryRoot: fixture.repositoryRoot,
    });
    const session = result.sessions.find(({ models }) =>
      models.some(({ model }) => model === "unknown-test-model")
    );
    assert.ok(session);
    assert.equal(session.tokens.inputTokens, 1500);
    assert.equal(session.cost.totalUsd, 0);
    assert.equal(session.costComplete, false);
    assert.equal(session.pricedTokenCoverage, 0);
    assert.equal(
      session.transcript.warnings.some((warning) => warning === "No rate card is configured for unknown-test-model."),
      true,
    );
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("discovers provider sessions when optional Conductor metadata is absent", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "machine-session-no-metadata-"));
  try {
    const fixture = await createSessionAnalyticsFixture(temporaryDirectory);
    const result = await analyzeMachineSessions({
      claudeRoot: fixture.claudeRoot,
      codexArchiveRoot: fixture.codexArchiveRoot,
      codexRoot: fixture.codexRoot,
      cursorDatabasePath: fixture.cursorDatabasePath,
      databasePath: join(temporaryDirectory, "missing-conductor.db"),
    });
    assert.equal(result.summary.sessions, 5);
    assert.deepEqual(
      [...new Set(result.sessions.map(({ provider }) => provider))].sort(),
      ["claude", "codex", "cursor"],
    );
    assert.equal(result.summary.missingTranscripts, 0);
    assert.ok(result.summary.repositoriesWithSessions >= 1);

    const cursorSession = result.sessions.find(({ provider }) => provider === "cursor");
    assert.ok(cursorSession);
    const cursorRepository = await analyzeRepositorySessions({
      claudeRoot: fixture.claudeRoot,
      codexArchiveRoot: fixture.codexArchiveRoot,
      codexRoot: fixture.codexRoot,
      cursorDatabasePath: fixture.cursorDatabasePath,
      databasePath: join(temporaryDirectory, "missing-conductor.db"),
      repositoryId: cursorSession.repositoryId,
    });
    assert.ok(cursorRepository.summary.sessions >= 1);
    assert.equal(cursorRepository.sessions.every(({ provider }) => provider === "cursor"), true);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("never charges an unobserved process-wide counter baseline to a session or a day", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "machine-session-counter-baseline-"));
  try {
    const fixture = await createSessionAnalyticsFixture(temporaryDirectory);
    // Codex broadcasts one process-wide cumulative counter into every session
    // file the process owns. A sub-agent spawned mid-run therefore sees a large
    // opening snapshot describing requests it never issued, and Codex does not
    // always attach per-request `last_token_usage` to it. Only the delta between
    // two snapshots this file observed is attributable.
    const sessionId = "44444444-4444-4444-8444-444444444444";
    const records = [
      {
        payload: { cwd: fixture.repositoryRoot, id: sessionId },
        timestamp: "2026-07-20T11:00:00Z",
        type: "session_meta",
      },
      {
        payload: { effort: "high", model: "gpt-5.6-sol" },
        timestamp: "2026-07-20T11:00:01Z",
        type: "turn_context",
      },
      {
        payload: {
          info: {
            total_token_usage: {
              cached_input_tokens: 890_000_000,
              input_tokens: 900_000_000,
              output_tokens: 5_000_000,
              reasoning_output_tokens: 1_000_000,
            },
          },
          type: "token_count",
        },
        timestamp: "2026-07-20T11:00:02Z",
        type: "event_msg",
      },
      {
        payload: {
          info: {
            total_token_usage: {
              cached_input_tokens: 890_100_000,
              input_tokens: 900_120_000,
              output_tokens: 5_000_300,
              reasoning_output_tokens: 1_000_100,
            },
          },
          type: "token_count",
        },
        timestamp: "2026-07-20T11:00:03Z",
        type: "event_msg",
      },
    ];
    await writeFile(
      join(fixture.codexRoot, "2026/07/20", `rollout-2026-07-20T11-00-00-${sessionId}.jsonl`),
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );

    const result = await analyzeRepositorySessions({
      claudeRoot: fixture.claudeRoot,
      codexArchiveRoot: fixture.codexArchiveRoot,
      codexRoot: fixture.codexRoot,
      cursorDatabasePath: fixture.cursorDatabasePath,
      databasePath: fixture.databasePath,
      repositoryRemote: fixture.remote,
      repositoryRoot: fixture.repositoryRoot,
    });
    const session = result.sessions.find(
      ({ firstEventAt, provider }) =>
        provider === "codex" && firstEventAt === "2026-07-20T11:00:00Z",
    );
    assert.ok(session);
    assert.equal(session.tokens.inputTokens, 120_000);
    assert.equal(session.tokens.cachedInputTokens, 100_000);
    assert.equal(session.tokens.uncachedInputTokens, 20_000);
    assert.equal(session.tokens.outputTokens, 300);
    assert.equal(Number(session.cost.totalUsd.toFixed(6)), 0.126);
    assert.equal(
      session.transcript.warnings.some((warning) =>
        warning.includes("process-wide counter baseline")
      ),
      true,
    );
    const day = result.spendByDay.find(({ name }) => name === "2026-07-20");
    assert.ok(day);
    // The 900M-token opening snapshot must not land on the calendar day the
    // sub-agent happened to start on.
    assert.ok(day.value < 1, `unexpected daily spend ${day.value}`);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});
