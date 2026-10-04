import assert from 'node:assert/strict';
import test from 'node:test';
import { counters } from './oracle.mjs';

test('physical Claude input classes are disjoint; thinking stays inside output',()=>{
  const result=counters({input_tokens:10,cache_read_input_tokens:20,cache_creation_input_tokens:30,cache_creation:{ephemeral_5m_input_tokens:12,ephemeral_1h_input_tokens:18},output_tokens:40,output_tokens_details:{thinking_tokens:25}});
  assert.equal(result.inputTokens,60);assert.equal(result.outputTokens,40);assert.equal(result.reasoningOutputTokens,25);assert.equal(result.nonReasoningOutputTokens,15);
});
test('absent thinking does not establish a non-reasoning classification',()=>{
  const result=counters({output_tokens:40});assert.equal(result.outputTokens,40);assert.equal(result.reasoningOutputTokens,0);assert.equal(result.nonReasoningOutputTokens,0);
});
test('separately observed TTL classes establish missing aggregate writes',()=>{
  const result=counters({input_tokens:5,cache_creation:{ephemeral_5m_input_tokens:10,ephemeral_1h_input_tokens:20}});assert.equal(result.cacheWriteInputTokens,30);assert.equal(result.inputTokens,35);
});
test('negative, nonnumeric and nonfinite counters cannot create usage',()=>{
  const result=counters({input_tokens:-1,cache_read_input_tokens:'20',cache_creation_input_tokens:Infinity,output_tokens:NaN});assert.equal(result.inputTokens+result.outputTokens,0);
});
