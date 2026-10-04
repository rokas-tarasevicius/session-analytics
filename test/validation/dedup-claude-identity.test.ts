import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeMachineSessions } from "../../src/analyzer.ts";

// All histories and identifiers in these intentionally failing regressions are synthetic.
const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const at = "2026-09-01T10:00:00.000Z";
const secret = "validation-private-content-sentinel";
function record(id: string, message: string, input = 100, output = 10) {
  return {type:"assistant", sessionId:id, cwd:"/synthetic/validation-project", timestamp:at,
    uuid:`record-${message}`, requestId:`request-${message}`, message:{id:message, model:"claude-opus-5",
      content:[{type:"text",text:secret}], usage:{input_tokens:input,output_tokens:output},stop_reason:"end_turn"}};
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dedup-claude-validation-"));
  const claudeRoot = join(root,"claude");
  const codexRoot = join(root,"codex");
  await mkdir(claudeRoot); await mkdir(codexRoot);
  return {root, claudeRoot, options:{claudeRoot,codexRoot,codexArchiveRoot:join(root,"archive"),
    cursorDatabasePath:join(root,"absent-cursor.db"),databasePath:join(root,"absent-conductor.db"),
    dataDir:join(root,"data"),pricingPolicy:"reviewed-only" as const,noIndex:true,additionalProviders:false}};
}
async function jsonl(file: string, records: unknown[]) {
  await writeFile(file,records.map(r=>JSON.stringify(r)).join("\n")+"\n");
}
test("DEDUP-CL-01: complementary copies of one identity retain all unique messages and child evidence", async () => {
  const f = await fixture();
  try {
    for (const name of ["copy-a","copy-b"]) await mkdir(join(f.claudeRoot,name,firstId,"subagents"),{recursive:true});
    await jsonl(join(f.claudeRoot,"copy-a",`${firstId}.jsonl`),[record(firstId,"shared"),record(firstId,"only-a",200,20)]);
    await jsonl(join(f.claudeRoot,"copy-b",`${firstId}.jsonl`),[record(firstId,"shared"),record(firstId,"only-b",300,30)]);
    await jsonl(join(f.claudeRoot,"copy-b",firstId,"subagents","agent-child.jsonl"),[record(firstId,"child",400,40)]);
    const result=await analyzeMachineSessions(f.options);
    assert.doesNotMatch(JSON.stringify(result),new RegExp(secret));
    assert.equal(result.sessions.length,1);
    assert.equal(result.sessions[0]!.tokens.inputTokens,1000);
    assert.equal(result.sessions[0]!.tokens.outputTokens,100);
    assert.equal(result.sessions[0]!.metrics.modelCalls,4);
  } finally { await rm(f.root,{recursive:true,force:true}); }
});

test("DEDUP-CL-02: a resumed new identity cannot rebill an identical earlier response", async () => {
  const f = await fixture();
  try {
    const replay=record(firstId,"original-request",100,10);
    await jsonl(join(f.claudeRoot,`${firstId}.jsonl`),[replay]);
    // A new provider identity can prepend the earlier session's exact records.
    await jsonl(join(f.claudeRoot,`${secondId}.jsonl`),[
      {type:"user",sessionId:secondId,cwd:"/synthetic/validation-project",timestamp:at,message:{content:secret}},
      replay,record(secondId,"new-request",200,20),
    ]);
    const result=await analyzeMachineSessions(f.options);
    assert.doesNotMatch(JSON.stringify(result),new RegExp(secret));
    assert.equal(result.sessions.length,2);
    assert.equal(result.sessions.reduce((n,s)=>n+s.tokens.inputTokens,0),300);
    assert.equal(result.sessions.reduce((n,s)=>n+s.tokens.outputTokens,0),30);
    assert.equal(result.sessions.reduce((n,s)=>n+s.metrics.modelCalls,0),2);
  } finally { await rm(f.root,{recursive:true,force:true}); }
});

test("DEDUP-CL-03: surviving child transcripts remain evidence after the main file is removed", async () => {
  const f = await fixture();
  try {
    const childDir=join(f.claudeRoot,firstId,"subagents");
    await mkdir(childDir,{recursive:true});
    await jsonl(join(childDir,"agent-retained.jsonl"),[record(firstId,"child-request")]);
    const result=await analyzeMachineSessions(f.options);
    assert.doesNotMatch(JSON.stringify(result),new RegExp(secret));
    assert.equal(result.sessions.length,1);
    assert.equal(result.sessions[0]!.tokens.inputTokens,100);
    assert.equal(result.sessions[0]!.tokens.outputTokens,10);
    assert.equal(result.sessions[0]!.executionKind,"subagent");
    assert.equal(result.sessions[0]!.transcript.completeness,"partial");
  } finally { await rm(f.root,{recursive:true,force:true}); }
});

test("DEDUP-CL-04: unreadable child evidence cannot silently remove a healthy main session", async () => {
  const f = await fixture();
  const childDir=join(f.claudeRoot,firstId,"subagents");
  try {
    await jsonl(join(f.claudeRoot,`${firstId}.jsonl`),[record(firstId,"main-request")]);
    await mkdir(childDir,{recursive:true});
    await chmod(childDir,0);
    const result=await analyzeMachineSessions(f.options);
    assert.equal(result.sessions.length,1);
    assert.equal(result.sessions[0]!.tokens.inputTokens,100);
    assert.equal(result.sessions[0]!.transcript.completeness,"partial");
    assert.ok(result.sessions[0]!.transcript.warnings.length>1);
  } finally { await chmod(childDir,0o700).catch(()=>{}); await rm(f.root,{recursive:true,force:true}); }
});
