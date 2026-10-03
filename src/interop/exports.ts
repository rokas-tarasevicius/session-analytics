import { InteropError } from "./error.ts";
import type { MachineAnalytics } from "../types.ts";
import { csvTables } from "../public/export-data.js";
import { validateSnapshot } from "./snapshot.ts";
import { otlpLogs } from "./otlp.ts";

export type ExportFormat = "csv" | "ndjson" | "otlp-json";

export function exportFiles(value: MachineAnalytics, format: ExportFormat): Record<string, string> {
  const snapshot = validateSnapshot(value);
  if (format === "csv") return csvTables(snapshot);
  if (format === "otlp-json") return { "otlp-logs.json": `${JSON.stringify(otlpLogs(snapshot), null, 2)}\n` };
  if (format !== "ndjson") throw new InteropError("Unknown export format.");
  const { sessions, repositories, ...metadata } = snapshot;
  const rows = [
    { ...metadata, kind: "snapshot" },
    ...repositories.map((repository) => ({ schemaVersion: 1, kind: "repository", ...repository })),
    ...sessions.map((session) => ({ schemaVersion: 1, kind: "session", ...session })),
  ];
  return { "snapshot.ndjson": `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` };
}
