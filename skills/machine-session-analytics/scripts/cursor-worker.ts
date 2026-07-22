import { cursorSessions, type RepositoryRow } from "./analyzer.ts";

interface CursorWorkerInput {
  databasePath: string;
  repositories: RepositoryRow[];
  workspaceRepositories: Array<[string, RepositoryRow]>;
}

let serializedInput = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) serializedInput += chunk;
const input = JSON.parse(serializedInput) as CursorWorkerInput;
const discovered = new Map<string, RepositoryRow>();
const result = await cursorSessions(
  input.databasePath,
  input.repositories,
  new Map(input.workspaceRepositories),
  discovered,
);

process.stdout.write(JSON.stringify({
  ...result,
  discovered: [...discovered.values()],
}));
