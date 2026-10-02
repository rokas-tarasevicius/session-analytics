import { analysisValueFlags } from "../options.ts";

export function parseCommandArguments(argv: string[], values: string[], booleans: string[]): Map<string, string | true> {
  const valueFlags = new Set([...analysisValueFlags, ...values]);
  const booleanFlags = new Set(["--exclude-hidden", "--include-hidden", "--help", "--version", ...booleans]);
  const parsed = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index]!;
    if (parsed.has(key) || (!valueFlags.has(key) && !booleanFlags.has(key))) throw new Error("Invalid or repeated command option. Use --help for supported options.");
    if (valueFlags.has(key)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("A command option requires a value. Use --help for supported options.");
      parsed.set(key, value);
    } else parsed.set(key, true);
  }
  return parsed;
}
