import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { analyzeMachineSessions, analyzeRepositorySessions } from "./analyzer.ts";
import { createSessionAnalyticsFixture } from "./test-support.ts";

test("analyzes Codex, Claude, and Cursor sessions without returning transcript content", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "conductor-session-analytics-"));
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
    assert.equal(result.summary.subagentSessions, 1);
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
    assert.equal(codex.cost.totalUsd, 0.0066);
    assert.equal(codex.cost.upperEstimateUsd, 0.006975);
    assert.deepEqual(codex.tools, { apply_patch: 1, exec_command: 1 });
    assert.equal(codex.metrics.taskCompletions, 1);
    assert.equal(codex.metrics.compactions, 1);
    assert.equal(codex.metrics.contextUtilizationPeak, 0.5);
    assert.equal(codex.executionKind, "top-level");
    assert.equal(codex.costBasis, "api-list-price-equivalent");
    const archivedSubagent = result.sessions.find(({ executionKind }) => executionKind === "mixed");
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
    assert.deepEqual(claude.tools, { Bash: 1, Read: 1 });
    assert.equal(claude.metrics.assistantMessages, 2);
    assert.equal(claude.metrics.userTurns, 1);
    assert.equal(claude.metrics.delegatedAgents, 1);
    assert.equal(claude.transcript.files, 2);

    const cursor = result.sessions.find(({ models }) => models.some(({ model }) => model === "cursor-fixture-model"));
    assert.ok(cursor);
    assert.equal(cursor.tokens.inputTokens, 200);
    assert.equal(cursor.tokens.outputTokens, 40);
    assert.equal(cursor.pricedTokenCoverage, null);
    assert.equal(cursor.cost.totalUsd, 1.23);
    assert.equal(cursor.costBasis, "provider-reported");
    assert.deepEqual(cursor.tools, { edit_file: 1 });
    const metadataOnlyCursor = result.sessions.find(({ models }) => models.some(({ model }) => model === "cursor-archived-model"));
    assert.ok(metadataOnlyCursor);
    assert.equal(metadataOnlyCursor.cost.totalUsd, 0.25);
    assert.deepEqual(metadataOnlyCursor.spendByDay, {});
    assert.equal(metadataOnlyCursor.metrics.modelCalls, 1);
    assert.equal(metadataOnlyCursor.tokens.inputTokens, 300);
    assert.deepEqual(metadataOnlyCursor.tools, { search_code: 1 });

    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /secret-command|secret-path|content-is-not-returned/);
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
