"""Generate reviewable independent src-only proposals; never mutate checkout src/."""
from pathlib import Path
import difflib
root=Path.cwd()
base={f:(root/f).read_text() for f in ['src/analyzer.ts','src/providers/claude.ts']}
def emit(bug, changes):
    text=''
    stage=root/'.lane'/('proposal-'+bug)
    for f,value in changes.items():
        dest=stage/f;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_text(value)
        text+=''.join(difflib.unified_diff(base.get(f,'').splitlines(True),value.splitlines(True),fromfile='a/'+f if f in base else '/dev/null',tofile='b/'+f))
    (root/'.lane/fixes'/f'{bug}.patch').write_text(text)
def replace(s, old, new):
    assert old in s,old[:100]
    return s.replace(old,new)
# CL-01: carry every validated main-file copy through the Claude composite.
a=base['src/analyzer.ts'];c=base['src/providers/claude.ts']
a=replace(a,'interface TranscriptCandidate {\n  cwd:', 'interface TranscriptCandidate {\n  paths?: string[];\n  cwd:')
a=replace(a,'    for (const path of paths) {\n      const identity = await transcriptIdentity(path, provider);\n      if (identity.id === filenameId && identity.cwd) {\n        return { cwd: identity.cwd, id: filenameId, path, provider, timestamp: identity.timestamp };\n      }\n    }\n    return null;', '''    let selected: TranscriptCandidate | null = null;
    const copies: string[] = [];
    for (const path of paths) {
      const identity = await transcriptIdentity(path, provider);
      if (identity.id === filenameId && identity.cwd) {
        selected ??= { cwd: identity.cwd, id: filenameId, path, provider, timestamp: identity.timestamp };
        copies.push(path);
        if (provider === "codex") break;
      }
    }
    if (selected && provider === "claude") selected.paths = copies;
    return selected;''')
a=replace(a,'contentRules = false, index: IndexScan | null = null): Promise<SessionAnalytics | null> {\n  if (index) {\n    const history', 'contentRules = false, index: IndexScan | null = null, mainPaths: string[] = [path]): Promise<SessionAnalytics | null> {\n  if (index) {\n    const history')
a=replace(a,'await claudeEvidencePaths(path), warnings,','(await Promise.all(mainPaths.map(claudeEvidencePaths))).flat(), warnings,')
a=replace(a,'outcomeEnricher, workflowSources, contentRules),\n      undefined', 'outcomeEnricher, workflowSources, contentRules, null, mainPaths),\n      undefined')
a=replace(a,'outcomeEnricher, workflowSources, contentRules });','outcomeEnricher, workflowSources, contentRules, mainPaths });')
a=replace(a,'outcomeEnricher, workflowSources, contentRules, index);\n  if (session)', 'outcomeEnricher, workflowSources, contentRules, index, candidate.paths);\n  if (session)')
a=replace(a,': await analyzeClaude(row, selected.path!, rateCard, selected.warnings, reliabilityContext, limits, outcomeEnricher, workflowSources, options.workflowContentRules, index)', ': await analyzeClaude(row, selected.path!, rateCard, selected.warnings, reliabilityContext, limits, outcomeEnricher, workflowSources, options.workflowContentRules, index, claudeCandidates.find(candidate => candidate.id === row.provider_session_id)?.paths)')
a=replace(a,'rateCard, ["Recovered from a unique working-directory and start-time match in the provider transcript store."], reliabilityContext, limits, outcomeEnricher, workflowSources, options.workflowContentRules, index)', 'rateCard, ["Recovered from a unique working-directory and start-time match in the provider transcript store."], reliabilityContext, limits, outcomeEnricher, workflowSources, options.workflowContentRules, index, candidate.paths)')
c=replace(c,'interface ClaudeContext { row:', 'interface ClaudeContext { mainPaths?: string[]; row:')
c=replace(c,'    contentRules = false,\n  ):', '    contentRules = false,\n    mainPaths: string[] = [mainPath],\n  ):')
c=replace(c,'const paths = await claudeEvidencePaths(mainPath);','const primaryPaths = new Set(mainPaths);\n    const paths = [...new Set((await Promise.all(mainPaths.map(claudeEvidencePaths))).flat())];')
c=replace(c,'path === mainPath ? "top-level" : "subagent";', 'primaryPaths.has(path) ? "top-level" : "subagent";')
c=replace(c,'context.workflowSources, context.contentRules);','context.workflowSources, context.contentRules, context.mainPaths);')
emit('DEDUP-CL-01',{'src/analyzer.ts':a,'src/providers/claude.ts':c})
# CL-02: build message ownership once per full scan from raw response IDs.
# Choose maximal final usage, then original recorded session, then timestamp/id.
a=base['src/analyzer.ts'];c=base['src/providers/claude.ts']
helper='''async function claudeMessageOwners(candidates: TranscriptCandidate[]): Promise<Map<string, string>> {
  const observations = new Map<string, { id: string; output: number; original: boolean; at: string }>();
  for (const candidate of candidates) {
    for (const path of await claudeEvidencePaths(candidate.path)) {
      await visitJsonLines(path, record => {
        if (record["type"] !== "assistant") return;
        const message = asRecord(record["message"]);
        const key = stringValue(message?.["id"]);
        if (!key) return; // Never merge absent response IDs by numeric usage alone.
        const proposed = { id: candidate.id,
          output: nonNegativeNumberValue(asRecord(message?.["usage"])?.["output_tokens"]),
          original: record["sessionId"] === candidate.id,
          at: normalizeTimestamp(record["timestamp"]) ?? "\\uffff" };
        const current = observations.get(key);
        if (!current || proposed.output > current.output ||
          (proposed.output === current.output && (Number(proposed.original) > Number(current.original) ||
            (proposed.original === current.original && `${proposed.at}:${proposed.id}` < `${current.at}:${current.id}`)))) observations.set(key, proposed);
      });
    }
  }
  return new Map([...observations].map(([key, value]) => [key, value.id]));
}

'''
a=replace(a,'async function analyzeClaude(row:',helper+'async function analyzeClaude(row:')
a=replace(a,'contentRules = false, index: IndexScan | null = null): Promise<SessionAnalytics | null> {\n  if (index) {\n    const history', 'contentRules = false, index: IndexScan | null = null, usageOwners?: Map<string, string>): Promise<SessionAnalytics | null> {\n  if (index) {\n    const history')
a=replace(a,'outcomeEnricher, workflowSources, contentRules),\n      undefined', 'outcomeEnricher, workflowSources, contentRules, null, usageOwners),\n      undefined')
a=replace(a,'outcomeEnricher, workflowSources, contentRules });','outcomeEnricher, workflowSources, contentRules, usageOwners });')
a=replace(a,'  index: IndexScan | null = null,\n): Promise<SessionAnalytics | null> {\n  const timestamp', '  index: IndexScan | null = null,\n  usageOwners?: Map<string, string>,\n): Promise<SessionAnalytics | null> {\n  const timestamp')
a=replace(a,'outcomeEnricher, workflowSources, contentRules, index);\n  if (session)', 'outcomeEnricher, workflowSources, contentRules, index, usageOwners);\n  if (session)')
a=replace(a,'    const claimedCodexCounters = new Set<string>();','    const usageOwners = await claudeMessageOwners(claudeCandidates);\n    const claimedCodexCounters = new Set<string>();')
a=replace(a,': await analyzeClaude(row, selected.path!, rateCard, selected.warnings, reliabilityContext, limits, outcomeEnricher, workflowSources, options.workflowContentRules, index)', ': await analyzeClaude(row, selected.path!, rateCard, selected.warnings, reliabilityContext, limits, outcomeEnricher, workflowSources, options.workflowContentRules, index, usageOwners)')
a=replace(a,'rateCard, ["Recovered from a unique working-directory and start-time match in the provider transcript store."], reliabilityContext, limits, outcomeEnricher, workflowSources, options.workflowContentRules, index)', 'rateCard, ["Recovered from a unique working-directory and start-time match in the provider transcript store."], reliabilityContext, limits, outcomeEnricher, workflowSources, options.workflowContentRules, index, usageOwners)')
a=replace(a,'workflowSources, options.workflowContentRules, index), observeEvidence); } catch { return null; }','workflowSources, options.workflowContentRules, index, usageOwners), observeEvidence); } catch { return null; }')
c=replace(c,'interface ClaudeContext { row:', 'interface ClaudeContext { usageOwners?: Map<string, string>; row:')
c=replace(c,'    contentRules = false,\n  ):', '    contentRules = false,\n    usageOwners?: Map<string, string>,\n  ):')
c=replace(c,'          const messageId =\n            stringValue(message["id"]) ?? stringValue(record["uuid"]) ?? `${path}:${line}`;', '''          const messageId =
            stringValue(message["id"]) ?? stringValue(record["uuid"]) ?? `${path}:${line}`;
          const owner = usageOwners?.get(messageId);
          const localIdentity = row.provider_session_id ?? stringValue(record["sessionId"]);
          if (owner && owner !== localIdentity) return;''')
c=replace(c,'context.workflowSources, context.contentRules);','context.workflowSources, context.contentRules, context.usageOwners);')
emit('DEDUP-CL-02',{'src/analyzer.ts':a,'src/providers/claude.ts':c})
# CL-03: use validated surviving children to form a partial subagent-only composite.
a=base['src/analyzer.ts'];c=base['src/providers/claude.ts']
a=replace(a,'      if (provider === "claude" && path.includes("/subagents/")) continue;', '''      if (provider === "claude" && path.includes("/subagents/")) {
        const identity = await transcriptIdentity(path, provider);
        const parent = basename(path.split("/subagents/")[0]!);
        if (identity.id === parent && identity.cwd && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(parent)) {
          const mains = index.get(parent) ?? [];
          mains.push(path); index.set(parent, mains);
        }
        continue;
      }''')
a=replace(a,'    for (const path of paths) {\n      const identity = await transcriptIdentity(path, provider);', '    for (const path of [...paths].sort((a, b) => Number(a.includes("/subagents/")) - Number(b.includes("/subagents/")))) {\n      const identity = await transcriptIdentity(path, provider);')
a=replace(a,'  for (const candidate of candidates) {\n    const identity = await transcriptIdentity(candidate, provider);', '  for (const candidate of [...candidates].sort((a, b) => Number(a.includes(\"/subagents/\")) - Number(b.includes(\"/subagents/\")))) {\n    const identity = await transcriptIdentity(candidate, provider);')
# A selected orphan child stands for all siblings in its subtree. The main-file case stays unchanged.
c=replace(c,'    const subagentRoot = mainPath.slice(0, -".jsonl".length) + "/subagents";', '    const orphan = mainPath.includes("/subagents/");\n    const subagentRoot = orphan ? mainPath.slice(0, mainPath.indexOf("/subagents/") + "/subagents".length) : mainPath.slice(0, -".jsonl".length) + "/subagents";')
c=replace(c,'    return paths;\n  }','    return [...new Set(paths)];\n  }')
c=replace(c,'    state.executionKind = "top-level";\n    state.executionKindsSeen.add("top-level");','    const orphan = mainPath.includes("/subagents/");\n    state.executionKind = orphan ? "subagent" : "top-level";\n    state.executionKindsSeen.add(state.executionKind);\n    if (orphan) state.warnings.push("Primary transcript is unavailable; surviving child evidence is partial.");')
c=replace(c,'path === mainPath ? "top-level" : "subagent";', '!orphan && path === mainPath ? "top-level" : "subagent";')
c=replace(c,'if (path === mainPath) updateWorkflow', 'if (!orphan && path === mainPath) updateWorkflow')
c=replace(c,'state.completeness = parseErrors || changed ? "partial" : "complete";', 'state.completeness = orphan || parseErrors || changed ? "partial" : "complete";')
emit('DEDUP-CL-03',{'src/analyzer.ts':a,'src/providers/claude.ts':c})
# CL-04: child-directory discovery errors degrade evidence, not the complete session.
a=base['src/analyzer.ts'];c=base['src/providers/claude.ts']
a=replace(a,'  provider: \"claude\" | \"codex\",\n): AsyncGenerator<string> {','  provider: \"claude\" | \"codex\",\n  unavailable: () => void = () => {},\n): AsyncGenerator<string> {')
a=replace(a,'      yield* walkProviderTranscripts(path, provider);','      try { yield* walkProviderTranscripts(path, provider, unavailable); }\n      catch { unavailable(); }')
a=replace(a,'  const index = new Map<string, string[]>();\n  try {\n    for await (const path of walkProviderTranscripts(root, provider)) {','  const index = new Map<string, string[]>();\n  let unreadable = false;\n  try {\n    for await (const path of walkProviderTranscripts(root, provider, () => { unreadable = true; })) {')
a=replace(a,'  return { paths: index, warning: null };','  return { paths: index, warning: unreadable ? \"Some provider evidence directories could not be read.\" : null };')
c=replace(c,'async function claudeEvidencePaths(mainPath: string): Promise<string[]> {','async function claudeEvidencePaths(mainPath: string): Promise<{ paths: string[]; unavailable: boolean }> {')
c=replace(c,'    const paths = [mainPath];\n    try {','    const paths = [mainPath];\n    let unavailable = false;\n    try {')
c=replace(c,'      if (code !== "ENOENT") throw error;','      if (code !== "ENOENT") unavailable = true;')
c=replace(c,'    return paths;\n  }','    return { paths, unavailable };\n  }')
c=replace(c,'    const paths = await claudeEvidencePaths(mainPath);','    const { paths, unavailable } = await claudeEvidencePaths(mainPath);\n    if (unavailable) state.warnings.push("Some child transcript evidence could not be read; retained counters are partial.");')
c=replace(c,'state.completeness = parseErrors || changed ? "partial" : "complete";', 'state.completeness = unavailable || parseErrors || changed ? "partial" : "complete";')
emit('DEDUP-CL-04',{'src/analyzer.ts':a,'src/providers/claude.ts':c})
print('Generated four src-only proposed patches.')
