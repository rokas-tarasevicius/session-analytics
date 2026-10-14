#!/usr/bin/env node
/** Build the installable package into dist/ (or --out DIR): compiled ESM plus verbatim assets. No network, no runtime dependencies. */
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Execution-time references to TypeScript files that the import rewrite cannot reach; JSDoc type imports are comments. */
export function typeScriptReferences(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...code.matchAll(/(?:new URL|import|readFile|readFileSync)\(\s*["'`]([^"'`]+\.ts)["'`]/g)].map((match) => match[1]!);
}

/** Every emitted module must name only emitted files, and every moduleUrl() target must exist in the package. */
export function checkEmitted(out: string): string[] {
  const problems: string[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) { walk(path); continue; }
      if (!path.endsWith(".js")) continue;
      const source = readFileSync(path, "utf8");
      for (const reference of typeScriptReferences(source)) problems.push(`${relative(out, path)} still names ${reference}`);
      for (const [, specifier] of source.matchAll(/moduleUrl\(\s*["']([^"']+\.ts)["']/g)) {
        if (!existsSync(join(dirname(path), `${specifier!.slice(0, -3)}.js`))) problems.push(`${relative(out, path)} runs missing ${specifier!.slice(0, -3)}.js`);
      }
    }
  };
  for (const directory of ["bin", "src"]) walk(join(out, directory));
  return problems;
}

/** The published manifest: the root's identity and metadata, a compiled bin, and nothing that runs at install time. */
export function packageManifest(source: Record<string, unknown>): Record<string, unknown> {
  return {
    name: source["name"], version: source["version"], description: source["description"], license: source["license"],
    author: source["author"], type: "module", bin: { "session-analytics": "bin/session-analytics.js" },
    files: ["bin", "src", "data", "schemas", "skills", "CHANGELOG.md"], engines: { node: ">=24" }, os: ["darwin", "linux"],
    repository: source["repository"], homepage: source["homepage"], bugs: source["bugs"], keywords: source["keywords"],
  };
}

export function build(out: string): void {
  rmSync(out, { recursive: true, force: true });
  const tsc = spawnSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", join(root, "tsconfig.build.json"), "--outDir", out], { stdio: "inherit" });
  if (tsc.status !== 0) throw new Error("TypeScript compilation failed.");
  // After tsc, so these verbatim browser modules replace the copies tsc re-printed for server-side imports.
  const assets = (path: string): boolean => !basename(path).startsWith(".") && !path.endsWith(".d.ts");
  cpSync(join(root, "src/public"), join(out, "src/public"), { recursive: true, filter: assets });
  for (const directory of ["data", "schemas", "skills"]) cpSync(join(root, directory), join(out, directory), { recursive: true, filter: assets });
  for (const file of ["README.md", "LICENSE", "CHANGELOG.md"]) cpSync(join(root, file), join(out, file));
  const manifest = packageManifest(JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>);
  writeFileSync(join(out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  chmodSync(join(out, "bin/session-analytics.js"), 0o755);
  const problems = checkEmitted(out);
  if (problems.length) throw new Error(`The compiled package would fail at run time:\n  ${problems.join("\n  ")}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    if (args.length && (args.length !== 2 || args[0] !== "--out")) throw new Error("Usage: node scripts/build.ts [--out DIR]");
    const out = resolve(args[1] ?? join(root, "dist"));
    build(out);
    console.log(`Built ${relative(process.cwd(), out) || "."} for ${String(JSON.parse(readFileSync(join(out, "package.json"), "utf8")).version)}.`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Build failed."}\n`);
    process.exitCode = 1;
  }
}
