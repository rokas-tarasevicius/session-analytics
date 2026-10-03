import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SessionAnalyticsFixture } from "./fixtures.ts";

export const commandSentinels = /PRIVATE_FILE|PRIVATE_DIRECTORY|PRIVATE_RAW_ID|PRIVATE_ARGUMENT|PRIVATE_UNRELATED/;
export async function addCommandHistoryFixture(fixture: SessionAnalyticsFixture): Promise<void> {
  const profile = dirname(fixture.claudeRoot);
  for (const path of [join(profile, "skills", "custom.audit", "SKILL.md"), join(profile, "commands", "namespace", "check.md"), join(fixture.repositoryRoot, ".claude", "skills", "project-check", "SKILL.md")]) {
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, "PRIVATE_ARGUMENT skill/command body");
  }
  const names = ["/review", "/custom.audit", "/namespace:check", "/project-check", "/PRIVATE_FILE.txt", "/PRIVATE_DIRECTORY", "/PRIVATE_RAW_ID_42", "/PRIVATE_UNRELATED/path"];
  const rows = names.map((name, index) => ({ sessionId: "22222222-2222-4222-8222-222222222222", timestamp: Date.parse("2026-07-20T12:00:00Z") + index * 1000, display: `${name} PRIVATE_ARGUMENT` }));
  await writeFile(join(profile, "history.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}
