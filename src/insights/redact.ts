export interface RedactionCounts {
  credentials: number;
  identifiers: number;
  paths: number;
  urls: number;
  emails: number;
  codeBlocks: number;
}
export const emptyRedactions = (): RedactionCounts => ({ credentials: 0, identifiers: 0, paths: 0, urls: 0, emails: 0, codeBlocks: 0 });

/** Defense in depth for an explicitly authorized P3 review; arbitrary prose is not provably anonymous. */
export function redactExcerpt(raw: string, knownIdentifiers: string[] = []): { text: string; counts: RedactionCounts } {
  const counts = emptyRedactions();
  let text = raw;
  // Replace exact local metadata before generic patterns can split a path containing spaces.
  for (const value of [...new Set(knownIdentifiers)].filter((s) => s.length >= 3).sort((a, b) => b.length - a.length)) {
    const parts = text.split(value);
    counts.identifiers += parts.length - 1;
    text = parts.join("[redacted identifiers]");
  }
  const replace = (pattern: RegExp, kind: keyof RedactionCounts): void => {
    text = text.replace(pattern, () => { counts[kind]++; return `[redacted ${kind}]`; });
  };
  replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "credentials");
  replace(/```[\s\S]*?(?:```|$)/g, "codeBlocks");
  replace(/`[^`\n]*`/g, "codeBlocks");
  replace(/\b(?:Bearer\s+[^\s"'<>]+|(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_\-]{8,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/gi, "credentials");
  replace(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization)\b["']?\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, "credentials");
  replace(/\b(?:https?|ssh|git|file):\/\/[^\s<>"')\]]+|\bgit@[^\s<>"')\]]+/gi, "urls");
  replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "emails");
  replace(/(?:[A-Z]:[\\/]|~\/|\.{1,2}\/|\/)[^\s<>"'`|,;()[\]{}]+/gi, "paths");
  replace(/\b(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\b/g, "paths");
  replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9a-f]{24,}\b/gi, "identifiers");
  text = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  return { text, counts };
}
