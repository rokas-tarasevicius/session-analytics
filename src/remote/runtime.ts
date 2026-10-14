import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { version } from "../version.ts";

/** The install root this process runs from: a source checkout (.ts) or a compiled install (.js). */
export const installRoot = fileURLToPath(new URL("../../", import.meta.url));
export const bootstrapPath = fileURLToPath(new URL("./bootstrap.js", import.meta.url));
const packed = /^(?:package\.json|(?:bin|src|data|schemas)(?:\/[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*)+)$/;

export interface RuntimePayload {
  version: string;
  /** sha256 over the sorted manifest: path NUL size NUL bytes per file. */
  digest: string;
  files: number;
  /** Gzipped payload size before base64. */
  bytes: number;
  /** stdin for `run`: the bootstrap alone. */
  run: string;
  /** stdin for `install`: the payload as a global, then the bootstrap. */
  install: string;
}

function files(root: string, directory: string, prefix: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${prefix}${entry.name}`;
    if (entry.name.startsWith(".")) return [];
    if (entry.isDirectory()) return files(root, join(directory, entry.name), `${path}/`);
    return entry.isFile() && packed.test(path) ? [path] : [];
  });
}

/** The payload of the install at `root`: this one, or in tests another layout such as a compiled one. */
export function buildRuntime(root = installRoot): RuntimePayload {
  const paths = ["package.json", ...["bin", "src", "data", "schemas"].flatMap((directory) => files(root, directory, `${directory}/`))].sort();
  const contents = paths.map((path) => readFileSync(join(root, path)));
  const hash = createHash("sha256");
  paths.forEach((path, index) => { hash.update(`${path}\0${contents[index]!.length}\0`); hash.update(contents[index]!); });
  const payload = gzipSync(Buffer.concat([Buffer.from(`${JSON.stringify(paths.map((path, index) => [path, contents[index]!.length]))}\n`), ...contents]), { level: 9 });
  const bootstrap = readFileSync(bootstrapPath, "utf8");
  return {
    version, digest: hash.digest("hex"), files: paths.length, bytes: payload.length,
    run: bootstrap, install: `globalThis.SA_RUNTIME = "${payload.toString("base64")}";\n${bootstrap}`,
  };
}

let cached: RuntimePayload | undefined;
/** Built once per process; a dirty development worktree gets its own digest. */
export function runtimePayload(): RuntimePayload {
  cached ??= buildRuntime();
  return cached;
}
