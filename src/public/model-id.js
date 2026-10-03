/** The same bounded projection is used by parsers, rate catalogs and the Pricing view. */
export function validModelId(value) {
  if (typeof value !== "string" || value.length > 160) return false;
  // Keep bounded provider namespaces as exact identities; reject filesystem and credential shapes.
  const parts = value.split("/");
  if (parts.length > 3 || /^(?:Users|home|private|tmp|var|etc|usr|opt|mnt|Volumes|Library)$/i.test(parts[0])) return false;
  if (parts.length > 1) return parts.every((part, index) => index === 0 && part === "@cf" || validModelId(part));
  const model = value;
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(model) || model.includes("..")) return false;
  if (/\.(?:txt|jsonl?|ts|tsx|jsx?|md|py|log|csv|db|sqlite|pem|key)$/i.test(model)) return false;
  if (/^(?:sk|session|thread|message|msg|request|req|workspace|repository|user|org|proj)[_-]/i.test(model)) return false;
  if (/^(?:AKIA|ASIA)[A-Z0-9]{16}$/.test(model) || /^(?:gh[pousr]_|github_pat_|xox[baprs]-|AIza)/.test(model)) return false;
  if (/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i.test(model) ||
      /[a-f0-9]{24,}/i.test(model) || /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(model)) return false;
  return true;
}

export function projectModelId(value) {
  return validModelId(value) ? value : "<unknown>";
}
