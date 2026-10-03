/** The same bounded projection is used by parsers, rate catalogs and the Pricing view. */
export function validModelId(value) {
  if (typeof value !== "string" || value.length > 160) return false;
  // A slash is only meaningful for a recognized public lab namespace, never a path.
  const model = value.replace(/^(?:anthropic|openai)\//i, "");
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
