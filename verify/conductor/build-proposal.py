"""Compose reviewed source proposals in a temporary tree, never in src/.

No provider stores are opened. This file handles repository code and synthetic tests only.
"""
from pathlib import Path
import difflib
import shutil
import subprocess
import tempfile

root = Path.cwd()
stage = Path(tempfile.mkdtemp(prefix="conductor-validation-proposal-"))
for directory in ["src", "data", "test", "schemas", "docs", "bin", "scripts"]:
    shutil.copytree(root / directory, stage / directory)
for name in ["package.json", "tsconfig.json"]:
    shutil.copy(root / name, stage / name)
if (root / "node_modules").exists():
    (stage / "node_modules").symlink_to(root / "node_modules", target_is_directory=True)

def replace_once(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError("Proposal context changed; review required")
    return text.replace(old, new, 1)

source = (root / ".lane/fixes/conductor-accounting-proposed.ts").read_text()
source = replace_once(source,
    'const model = reportedModel(modelName(rawModel), modelTokens, finite(u["costUSD"]) ?? 0);',
    'const canonicalModel = rawModel.replace(/^(claude-[a-z0-9.-]+)\\[1m\\]$/, "$1");\n'
    '    const model = reportedModel(modelName(canonicalModel), modelTokens, finite(u["costUSD"]) ?? 0);')
source = replace_once(source, 'let costSnapshots = 0;', 'let costSnapshots = 0, allocationsComplete = true;')
source = replace_once(source,
    'if (cost !== null) { session.cost.totalUsd += cost; costSnapshots++; }',
    'if (cost !== null) { session.cost.totalUsd += cost; costSnapshots++; }\n'
    '      if (result.cost === null && result.models.some((model) => !model.priced)) allocationsComplete = false;')
source = replace_once(source,
    'const finalized = finish(session); finalized.pricedTokenCoverage = null; finalized.costComplete = marginalComplete || (complete && snapshots.length > 0 && costSnapshots === snapshots.length);',
    'if (!allocationsComplete && !marginalComplete) {\n'
    '      session.evidence!.accounting = "partial";\n'
    '      session.transcript.warnings.push("Reported model allocations are incomplete; recovered value is an observed lower bound.");\n'
    '    }\n'
    '    const finalized = finish(session); finalized.pricedTokenCoverage = null; finalized.costComplete = marginalComplete || (complete && allocationsComplete && snapshots.length > 0 && costSnapshots === snapshots.length);')
source = replace_once(source, 'import { emptySession,', 'import { count, emptySession,')
source = replace_once(source, 'function project(result:', '''function localTokens(usage: Record<string, unknown> | null): TokenUsage | null {
  if (!hasCounters(usage, ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"])) return null;
  const value = tokens(usage?.["input_tokens"], usage?.["cache_read_input_tokens"], usage?.["cache_creation_input_tokens"], usage?.["output_tokens"]);
  const cache = record(usage?.["cache_creation"]);
  value.cacheWrite1hInputTokens = Math.min(value.cacheWriteInputTokens, count(cache?.["ephemeral_1h_input_tokens"]));
  value.cacheWrite5mInputTokens = Math.min(value.cacheWriteInputTokens - value.cacheWrite1hInputTokens, count(cache?.["ephemeral_5m_input_tokens"]));
  return value;
}
function project(result:''')
source = replace_once(source,
    'localUsage: hasCounters(usage, ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) ? tokens(usage?.["input_tokens"], usage?.["cache_read_input_tokens"], usage?.["cache_creation_input_tokens"], usage?.["output_tokens"]) : null,',
    'localUsage: localTokens(usage),')
source = replace_once(source, 'if (session.models.length && Math.abs(', 'if (session.models.some((model) => model.priced) && Math.abs(')
source = replace_once(source,
    'session.sessionKey = hash(key); session.transcript.files = 0;',
    'const registeredOwners = rows.filter((r) => r.provider_session_id && key === `claude:${r.provider_session_id}`);\n'
    '    session.sessionKey = registeredOwners.length === 1 ? hash(registeredOwners[0]!.conductor_session_id) : hash(key);\n'
    '    session.transcript.files = 0;')
(stage / "src/providers/conductor.ts").write_text(source)
for name in ["VC-O1.patch", "VC-O3.patch"]:
    result = subprocess.run(["patch", "--batch", "-p1"], cwd=stage,
                            input=(root / ".lane/fixes" / name).read_text(), text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError("Analyzer proposal did not apply cleanly")

combined = ""
for relative in ["src/providers/conductor.ts", "src/analyzer.ts"]:
    combined += "".join(difflib.unified_diff((root / relative).read_text().splitlines(True),
                                          (stage / relative).read_text().splitlines(True),
                                          fromfile="a/" + relative, tofile="b/" + relative))
(root / ".lane/fixes/conductor-combined.patch").write_text(combined)
(root / ".lane/proposal-stage.txt").write_text(str(stage))
tests = sorted(str(p.relative_to(stage)) for p in (stage / "test/validation").glob("conductor-*.test.ts"))
result = subprocess.run(["node", "--test", "--test-concurrency=1", *tests], cwd=stage, capture_output=True, text=True)
(root / ".lane/conductor-combined-tests.log").write_text(result.stdout + result.stderr)
print("Combined proposal synthetic test exit code:", result.returncode)
if result.returncode:
    raise SystemExit(result.returncode)

# The old fixture asserted that every init UUID was a disjoint process. Keep
# the fixture, but make its expectations match the proved scope limitation.
result = subprocess.run(["patch", "--batch", "-p1"], cwd=stage,
                        input=(root / ".lane/fixes/conductor-existing-regression.patch").read_text(),
                        text=True, capture_output=True)
if result.returncode:
    raise RuntimeError("Existing regression proposal did not apply cleanly")
for label, command in [
    ("proposal-typecheck", ["npm", "run", "typecheck"]),
    ("proposal-provider-tests", ["node", "--test", "--test-concurrency=1", "test/provider-review.test.ts", "test/providers.test.ts"]),
]:
    result = subprocess.run(command, cwd=stage, capture_output=True, text=True)
    (root / ".lane" / (label + ".log")).write_text(result.stdout + result.stderr)
    print(label + " exit code:", result.returncode)
    if result.returncode:
        raise SystemExit(result.returncode)
